import type {
  AgentActionContract,
  AgentActionReceipt,
} from "../contracts/types";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import {
  listTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
  savePlanArtifact,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "./store";
import type {
  ApprovedPlanGrant,
  ExecutionTask,
  ExecutionTaskStatus,
  PlanArtifact,
  PlanAcceptanceCriterion,
  PlanCompletionRequirement,
  PlanCompletionRequirementKind,
  PlanContract,
  PlanExecutionLedger,
  PlanProvider,
  PlanStep,
  TaskEvidence,
  TaskTransitionRequest,
} from "./types";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";
import { buildDefaultPlanContract, decodePlanContract } from "./contracts";
import {
  listScopeSnapshotItems,
  saveResearchCorpusItem,
  saveResearchJob,
  saveResearchWorkItem,
} from "../research/store";
import { resolveResearchPolicy } from "../research/policy";

function normalizedText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

const CRITERION_VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "research_coverage",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "bounded_reasoning",
  "user_decision",
]);

function normalizeAcceptanceCriteria(
  value: readonly PlanAcceptanceCriterion[],
  label: string,
): PlanAcceptanceCriterion[] {
  if (!value.length) throw new Error(`${label} requires acceptance criteria`);
  const ids = new Set<string>();
  return value.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object") {
      throw new Error(`${label}[${index}] must be a typed criterion`);
    }
    const criterionId = normalizedText(
      criterion.criterionId,
      `${label}[${index}].criterionId`,
    );
    if (ids.has(criterionId)) {
      throw new Error(`${label} contains duplicate criterion ${criterionId}`);
    }
    ids.add(criterionId);
    if (!CRITERION_VERIFIERS.has(criterion.verifier)) {
      throw new Error(`${label}[${index}].verifier is invalid`);
    }
    return {
      criterionId,
      description: normalizedText(
        criterion.description,
        `${label}[${index}].description`,
      ),
      verifier: criterion.verifier,
    };
  });
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function inferPlanStepEffect(
  content: string,
): PlanStep["expectedEffect"] {
  const normalized = content.toLowerCase();
  if (
    /\b(?:create|write|edit|update|change|apply|delete|remove|move|import|upload|tag|organize|execute|run)\b/.test(
      normalized,
    )
  ) {
    return "mutation";
  }
  if (/\b(?:save|export|generate|produce)\b/.test(normalized))
    return "artifact";
  if (
    /\b(?:read|inspect|search|research|collect|review|verify|validate|check|audit)\b/.test(
      normalized,
    )
  ) {
    return "read";
  }
  return "reasoning";
}

function taskStatusAfterTransition(
  ledger: PlanExecutionLedger,
  tasks: readonly ExecutionTask[],
): PlanExecutionLedger["status"] {
  const required = tasks.filter((task) => task.kind === "required_step");
  if (tasks.some((task) => task.status === "waiting_for_user"))
    return "waiting_for_user";
  if (tasks.some((task) => task.status === "in_progress")) return "running";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "interrupted")) return "interrupted";
  if (required.some((task) => task.status === "cancelled")) return "cancelled";
  if (
    required.every((task) => task.status === "completed") &&
    tasks.every(
      (task) => task.status === "completed" || task.status === "cancelled",
    )
  ) {
    return "completed";
  }
  if (
    required.every(
      (task) => task.status === "completed" || task.status === "skipped",
    ) &&
    tasks.every((task) =>
      ["completed", "skipped", "cancelled"].includes(task.status),
    )
  ) {
    return "completed_with_exceptions";
  }
  return ledger.status === "pending" ? "pending" : "running";
}

const ALLOWED_TRANSITIONS: Record<ExecutionTaskStatus, ExecutionTaskStatus[]> =
  {
    pending: ["in_progress", "cancelled", "skipped"],
    in_progress: [
      "waiting_for_user",
      "interrupted",
      "completed",
      "blocked",
      "failed",
      "skipped",
      "cancelled",
    ],
    waiting_for_user: ["in_progress", "blocked", "skipped", "cancelled"],
    interrupted: ["in_progress", "completed", "failed", "cancelled"],
    completed: [],
    blocked: ["in_progress", "failed", "cancelled"],
    failed: ["in_progress", "cancelled"],
    skipped: [],
    cancelled: [],
  };

export function assertTaskTransitionRequest(params: {
  ledger: PlanExecutionLedger;
  task: ExecutionTask;
  request: TaskTransitionRequest;
}): void {
  const { ledger, task, request } = params;
  if (!ALLOWED_TRANSITIONS[task.status].includes(request.toStatus)) {
    throw new Error(
      `Invalid task transition: ${task.status} -> ${request.toStatus}`,
    );
  }
  if (
    request.toStatus === "in_progress" &&
    ledger.tasks.some(
      (entry) => entry.taskId !== task.taskId && entry.status === "in_progress",
    )
  ) {
    throw new Error("Only one user-visible task may be in progress");
  }
  if (
    request.toStatus === "skipped" &&
    task.kind === "required_step" &&
    request.requestedBy !== "user"
  ) {
    throw new Error("Only the user may skip an approved plan step");
  }
}

export function assertTaskCompletionEvidence(
  task: ExecutionTask,
  evidence: readonly TaskEvidence[],
): void {
  const verified = evidence.filter(
    (entry) =>
      entry.verified &&
      entry.executionId === task.executionId &&
      entry.taskId === task.taskId,
  );
  if (task.completionRequirements?.length) {
    for (const requirement of task.completionRequirements) {
      const matching = verified.filter(
        (entry) =>
          entry.requirementId === requirement.requirementId &&
          entry.contractDigest === requirement.contractDigest &&
          requirement.criterionIds.every((criterionId) =>
            entry.criterionIds?.includes(criterionId),
          ),
      );
      const satisfied =
        requirement.kind === "mutation_receipts"
          ? (() => {
              const valid = matching.filter(
                (entry) =>
                  entry.kind === "mutation_receipt" &&
                  entry.payload?.type === "mutation_receipts" &&
                  entry.payload.receiptIds.includes(entry.receipt?.id || "") &&
                  entry.receipt?.verification === "verified" &&
                  ["applied", "already_satisfied", "observed"].includes(
                    entry.receipt.status,
                  ),
              );
              return task.obligationIds.length
                ? task.obligationIds.every((obligationId) =>
                    valid.some(
                      (entry) => entry.receipt?.obligationId === obligationId,
                    ),
                  )
                : valid.length > 0;
            })()
          : matching.some((entry) => {
              if (requirement.kind === "verified_read") {
                return (
                  entry.kind === "verified_read" &&
                  entry.payload?.type === "verified_read" &&
                  Boolean(entry.payload.observations?.length)
                );
              }
              if (requirement.kind === "bounded_reasoning") {
                return (
                  entry.kind === "reasoning_assertion" &&
                  entry.payload?.type === "bounded_reasoning"
                );
              }
              if (requirement.kind === "research_coverage") {
                return (
                  entry.kind === "research_coverage" &&
                  entry.payload?.type === "research_coverage" &&
                  (entry.payload.coverageStatus === "complete" ||
                    entry.payload.coverageStatus ===
                      "complete_with_limitations")
                );
              }
              if (requirement.kind === "document_integrity") {
                return (
                  entry.kind === "document_integrity" &&
                  entry.payload?.type === "document_integrity" &&
                  entry.payload.integrityValidated
                );
              }
              if (requirement.kind === "document_published") {
                return (
                  entry.kind === "document_published" &&
                  entry.payload?.type === "document_published"
                );
              }
              if (requirement.kind === "user_decision") {
                return (
                  entry.kind === "user_decision" &&
                  entry.payload?.type === "user_decision"
                );
              }
              return false;
            });
      if (!satisfied) {
        throw new Error(
          `Task completion requirement ${requirement.kind} (${requirement.requirementId}) is not satisfied for contract ${requirement.contractDigest}`,
        );
      }
    }
    const integrity = verified.find(
      (entry) => entry.payload?.type === "document_integrity",
    )?.payload;
    const published = verified.find(
      (entry) => entry.payload?.type === "document_published",
    )?.payload;
    if (
      integrity?.type === "document_integrity" &&
      published?.type === "document_published" &&
      (integrity.documentId !== published.documentId ||
        integrity.contentHash !== published.contentHash)
    ) {
      throw new Error(
        "Document integrity and publication evidence do not match",
      );
    }
    return;
  }
  if (task.expectedEffect === "reasoning") {
    if (!verified.some((entry) => entry.kind === "reasoning_assertion")) {
      throw new Error("Reasoning task requires a bounded completion assertion");
    }
    return;
  }
  if (task.expectedEffect === "mutation") {
    if (
      !verified.some(
        (entry) =>
          entry.kind === "mutation_receipt" &&
          entry.receipt?.verification === "verified",
      )
    ) {
      throw new Error(
        "Mutation task cannot complete without a verified receipt",
      );
    }
    return;
  }
  if (task.expectedEffect === "artifact") {
    if (
      !verified.some(
        (entry) => entry.kind === "artifact" || entry.kind === "validation",
      )
    ) {
      throw new Error(
        "Artifact task requires a verified artifact or validation result",
      );
    }
    return;
  }
  if (
    !verified.some(
      (entry) => entry.kind === "verified_read" || entry.kind === "validation",
    )
  ) {
    throw new Error("Read task requires verified read evidence");
  }
}

export async function computePlanContractDigest(
  contract: PlanContract,
): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(contract))}`;
}

/**
 * Resolve only the authority that may exist before research has selected its
 * targets. A request-level classifier contract is deliberately ignored for an
 * after-research effect; that authority can only come from the second gate.
 */
export function resolvePreResearchActionContract(
  contract: PlanContract | undefined,
  fallback?: AgentActionContract,
): AgentActionContract | undefined {
  const effect = contract?.effects?.libraryMutation;
  if (effect?.approval === "after_research") return undefined;
  return effect?.approval === "initial" ? effect.contract : fallback;
}

export async function computePlanDigest(params: {
  planId: string;
  conversationKey: number;
  revision: number;
  actionContractId?: string;
  steps: readonly PlanStep[];
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
  contract?: PlanContract;
  contractDigest?: string;
}): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(params))}`;
}

function assignCompletionRequirements(params: {
  steps: readonly Omit<PlanStep, "completionRequirements">[];
  contractDigest: string;
}): PlanStep[] {
  return params.steps.map((step) => {
    const criteria =
      step.acceptanceCriteria as readonly PlanAcceptanceCriterion[];
    const grouped = new Map<
      PlanCompletionRequirementKind,
      PlanAcceptanceCriterion[]
    >();
    for (const criterion of criteria) {
      const entries = grouped.get(criterion.verifier) || [];
      entries.push(criterion);
      grouped.set(criterion.verifier, entries);
    }
    const completionRequirements: PlanCompletionRequirement[] = [
      ...grouped,
    ].map(([kind, entries]) => ({
      requirementId: `${step.planStepId}:requirement:${kind}`,
      kind,
      criterionIds: entries.map((entry) => entry.criterionId),
      contractDigest: params.contractDigest,
      targetBoundary: step.targetBoundary
        ? {
            targetIds: step.targetBoundary.targetIds,
            scopeDigest: step.targetBoundary.scopeDigest,
            expectedCount: step.targetBoundary.targetIds?.length,
          }
        : undefined,
    }));
    return { ...step, completionRequirements };
  });
}

function validatePlanStepContract(params: {
  contract: PlanContract;
  steps: readonly PlanStep[];
}): void {
  const mutationIndexes = params.steps
    .map((step, index) => (step.expectedEffect === "mutation" ? index : -1))
    .filter((index) => index >= 0);
  const effect = params.contract.effects?.libraryMutation;
  if (Boolean(effect) !== Boolean(mutationIndexes.length)) {
    throw new Error(
      effect
        ? "A library-mutation contract requires a mutation plan step"
        : "A mutation plan step requires an approved library-mutation contract",
    );
  }
  const requirementOwners = new Map<PlanCompletionRequirementKind, number[]>();
  params.steps.forEach((step, index) => {
    for (const requirement of step.completionRequirements || []) {
      const owners = requirementOwners.get(requirement.kind) || [];
      owners.push(index);
      requirementOwners.set(requirement.kind, owners);
      if (
        requirement.kind === "mutation_receipts" &&
        step.expectedEffect !== "mutation"
      ) {
        throw new Error("Mutation receipts may only complete a mutation step");
      }
      if (
        (requirement.kind === "document_integrity" ||
          requirement.kind === "document_published") &&
        step.expectedEffect !== "artifact"
      ) {
        throw new Error(
          "Document completion requirements require an artifact step",
        );
      }
    }
  });
  const exactlyOne = (kind: PlanCompletionRequirementKind): number => {
    const owners = requirementOwners.get(kind) || [];
    if (owners.length !== 1) {
      throw new Error(`A v3 plan requires exactly one ${kind} owner`);
    }
    return owners[0];
  };
  if (params.contract.investigation) {
    const researchOwner = exactlyOne("research_coverage");
    if (
      effect?.approval === "after_research" &&
      mutationIndexes.some((index) => index <= researchOwner)
    ) {
      throw new Error(
        "Research coverage must complete before a research-selected mutation step",
      );
    }
  } else if (requirementOwners.has("research_coverage")) {
    throw new Error("Research coverage requires an investigation contract");
  }
  if (effect) {
    const receiptOwners = requirementOwners.get("mutation_receipts") || [];
    if (
      receiptOwners.length !== mutationIndexes.length ||
      receiptOwners.some((index) => !mutationIndexes.includes(index))
    ) {
      throw new Error(
        "Every mutation step requires its own mutation-receipts requirement",
      );
    }
  }
  if (params.contract.deliverable.kind === "document") {
    const integrityOwner = exactlyOne("document_integrity");
    const publishedOwner = exactlyOne("document_published");
    const finalIndex = params.steps.length - 1;
    if (
      integrityOwner !== finalIndex ||
      publishedOwner !== finalIndex ||
      params.steps[finalIndex].expectedEffect !== "artifact"
    ) {
      throw new Error(
        "The formal document must be the final artifact step and own integrity and publication",
      );
    }
  } else if (
    requirementOwners.has("document_integrity") ||
    requirementOwners.has("document_published")
  ) {
    throw new Error(
      "Document completion requirements require a document deliverable",
    );
  }
}

export class PlanExecutionCoordinator {
  async bindResearchDerivedActionContract(params: {
    executionId: string;
    contract: AgentActionContract;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (
      !artifact ||
      artifact.digest !== ledger.planDigest ||
      artifact.contract?.effects?.libraryMutation.approval !== "after_research"
    ) {
      throw new Error("The plan does not authorize research-derived writes");
    }
    const now = params.now ?? Date.now();
    const updated: PlanExecutionLedger = {
      ...ledger,
      actionContractId: params.contract.id,
      tasks: ledger.tasks.map((task) =>
        task.expectedEffect === "mutation"
          ? {
              ...task,
              obligationIds: params.contract.obligations
                .filter(
                  (obligation) =>
                    !task.expectedCapability ||
                    obligation.capability === task.expectedCapability,
                )
                .map((obligation) => obligation.id),
              updatedAt: now,
            }
          : task,
      ),
      updatedAt: now,
    };
    if (
      updated.tasks.some(
        (task) =>
          task.expectedEffect === "mutation" && !task.obligationIds.length,
      )
    ) {
      throw new Error(
        "The exact mutation contract does not cover every approved mutation task",
      );
    }
    await savePlanExecutionLedger(updated, undefined, {
      alreadyInTransaction: params.alreadyInTransaction,
    });
    return updated;
  }

  async admitSupportingTask(params: {
    executionId: string;
    taskId: string;
    parentTaskId: string;
    content: string;
    activeForm?: string;
    acceptanceCriteria: readonly PlanAcceptanceCriterion[];
    expectedEffect: PlanStep["expectedEffect"];
    expectedCapability?: string;
    targetIds?: readonly string[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    if (ledger.tasks.some((task) => task.taskId === params.taskId))
      return ledger;
    const parent = ledger.tasks.find(
      (task) => task.taskId === params.parentTaskId,
    );
    if (!parent) throw new Error("Supporting task parent was not found");
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (!artifact || artifact.digest !== ledger.planDigest) {
      throw new Error("Approved plan identity changed");
    }
    const contract = artifact.actionContract;
    if (params.expectedEffect === "mutation") {
      const matching = contract?.obligations.filter(
        (obligation) =>
          !params.expectedCapability ||
          obligation.capability === params.expectedCapability,
      );
      if (!matching?.length) {
        throw new Error(
          "Supporting task is outside the approved action contract",
        );
      }
      if (params.targetIds?.length) {
        const authorized = new Set(
          matching.flatMap(
            (obligation) =>
              obligation.targetBoundary?.frozenTargetIds.map(String) || [],
          ),
        );
        if (
          authorized.size &&
          params.targetIds.some((target) => !authorized.has(String(target)))
        ) {
          throw new Error(
            "Supporting task targets are outside the approved boundary",
          );
        }
      }
    }
    const now = params.now ?? Date.now();
    const acceptanceCriteria = normalizeAcceptanceCriteria(
      params.acceptanceCriteria,
      "Supporting task acceptance criteria",
    );
    const supportingStep = assignCompletionRequirements({
      steps: [
        {
          planStepId: normalizedText(
            params.taskId,
            "Supporting task requirement namespace",
          ),
          content: params.content,
          activeForm: params.activeForm || params.content,
          acceptanceCriteria,
          expectedEffect: params.expectedEffect,
          expectedCapability: params.expectedCapability,
          targetBoundary: params.targetIds?.length
            ? { kind: "selection", targetIds: params.targetIds }
            : undefined,
        },
      ],
      contractDigest: artifact.contractDigest || artifact.digest,
    })[0];
    const child: ExecutionTask = {
      version: 2,
      taskId: normalizedText(params.taskId, "Supporting task ID"),
      executionId: ledger.executionId,
      planStepId: parent.planStepId,
      parentTaskId: parent.taskId,
      kind: "supporting_child",
      content: normalizedText(params.content, "Supporting task content"),
      activeForm: normalizedText(
        params.activeForm || params.content,
        "Supporting task activeForm",
      ),
      acceptanceCriteria,
      expectedEffect: params.expectedEffect,
      completionRequirements: supportingStep.completionRequirements,
      expectedCapability: params.expectedCapability,
      obligationIds: parent.obligationIds,
      status: "pending",
      attemptCount: 0,
      evidenceIds: [],
      failureReasons: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!child.acceptanceCriteria.length) {
      throw new Error("Supporting task requires acceptance criteria");
    }
    const updated: PlanExecutionLedger = {
      ...ledger,
      tasks: [...ledger.tasks, child],
      updatedAt: now,
    };
    await savePlanExecutionLedger(updated);
    return updated;
  }

  async cancelArtifact(params: {
    planId: string;
    revision: number;
    now?: number;
  }): Promise<PlanArtifact | null> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact || artifact.status === "approved") return artifact;
    const cancelled: PlanArtifact = {
      ...artifact,
      status: "cancelled",
      updatedAt: params.now ?? Date.now(),
    };
    await savePlanArtifact(cancelled);
    return cancelled;
  }

  async updateDraft(params: {
    planId: string;
    conversationKey: number;
    provider: PlanProvider;
    revision: number;
    explanation?: string;
    steps: ReadonlyArray<{
      planStepId?: string;
      content: string;
      activeForm?: string;
      acceptanceCriteria: readonly PlanAcceptanceCriterion[];
      expectedCapability?: string;
      expectedEffect: PlanStep["expectedEffect"];
      targetBoundary?: PlanStep["targetBoundary"];
    }>;
    contract?: PlanContract;
    actionContractId?: string;
    actionContract?: AgentActionContract;
    sourceRunId?: string;
    skillRoutingReceipt?: PlanSkillRoutingReceipt;
    ready?: boolean;
    now?: number;
  }): Promise<PlanArtifact> {
    const now = params.now ?? Date.now();
    const existing = await loadPlanArtifact(params.planId, params.revision);
    if (existing?.status === "approved") {
      throw new Error("An approved plan revision is immutable");
    }
    if (existing?.status === "cancelled" || existing?.status === "superseded") {
      throw new Error("This plan revision is no longer active");
    }
    if (!params.steps.length)
      throw new Error("A plan requires at least one step");
    const decodedContract = decodePlanContract(
      params.contract ||
        buildDefaultPlanContract({
          actionContract: params.actionContract,
          steps: params.steps,
        }),
      { requireSnapshot: params.ready === true },
    );
    const mutationEffect = decodedContract.effects?.libraryMutation;
    const initialMutation =
      mutationEffect?.approval === "initial"
        ? mutationEffect.contract
        : undefined;
    if (
      params.actionContract &&
      initialMutation &&
      params.actionContract.id !== initialMutation.id
    ) {
      throw new Error(
        "The plan contract action authority does not match the request",
      );
    }
    // An inferred request contract cannot authorize targets that research has
    // not selected yet. The only authority for an after-research effect is the
    // separately persisted exact-target grant created at the second gate.
    const actionContract = resolvePreResearchActionContract(
      decodedContract,
      params.actionContract,
    );
    const actionContractId = actionContract?.id;
    if (
      params.actionContractId &&
      params.actionContractId !== actionContractId
    ) {
      throw new Error(
        "The supplied action contract ID does not match the plan contract",
      );
    }
    const contractDigest = await computePlanContractDigest(decodedContract);
    const seen = new Set<string>();
    const seenCriteria = new Set<string>();
    const normalizedSteps = params.steps.map((step, index) => {
      const planStepId =
        step.planStepId?.trim() ||
        `${params.planId}:r${params.revision}:s${index + 1}`;
      if (seen.has(planStepId))
        throw new Error(`Duplicate planStepId: ${planStepId}`);
      seen.add(planStepId);
      const acceptanceCriteria = normalizeAcceptanceCriteria(
        step.acceptanceCriteria,
        `Plan step ${index + 1} acceptance criteria`,
      );
      for (const criterion of acceptanceCriteria) {
        if (seenCriteria.has(criterion.criterionId)) {
          throw new Error(
            `Duplicate acceptance criterion ID: ${criterion.criterionId}`,
          );
        }
        seenCriteria.add(criterion.criterionId);
      }
      return {
        planStepId,
        content: normalizedText(step.content, `Plan step ${index + 1} content`),
        activeForm: normalizedText(
          step.activeForm || step.content,
          `Plan step ${index + 1} activeForm`,
        ),
        acceptanceCriteria,
        expectedCapability: step.expectedCapability?.trim() || undefined,
        expectedEffect: step.expectedEffect,
        targetBoundary: step.targetBoundary,
      };
    });
    const steps = assignCompletionRequirements({
      steps: normalizedSteps,
      contractDigest,
    });
    validatePlanStepContract({ contract: decodedContract, steps });
    const digest = await computePlanDigest({
      planId: params.planId,
      conversationKey: params.conversationKey,
      revision: params.revision,
      actionContractId,
      steps,
      skillRoutingReceipt: params.skillRoutingReceipt,
      contract: decodedContract,
      contractDigest,
    });
    const artifact: PlanArtifact = {
      version: 4,
      planId: params.planId,
      conversationKey: params.conversationKey,
      provider: params.provider,
      revision: params.revision,
      digest,
      status: params.ready ? "awaiting_approval" : "drafting",
      explanation: params.explanation?.trim() || undefined,
      actionContractId,
      actionContract,
      sourceRunId: params.sourceRunId || existing?.sourceRunId,
      skillRoutingReceipt:
        params.skillRoutingReceipt || existing?.skillRoutingReceipt,
      contract: decodedContract,
      contractDigest,
      steps,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (params.revision > 1) {
      const prior = await loadPlanArtifact(params.planId, params.revision - 1);
      if (
        prior &&
        prior.status !== "approved" &&
        prior.status !== "cancelled"
      ) {
        await savePlanArtifact({
          ...prior,
          status: "superseded",
          updatedAt: now,
        });
      }
    }
    await savePlanArtifact(artifact);
    return artifact;
  }

  async approve(params: {
    planId: string;
    revision: number;
    conversationGeneration: number;
    actionContract?: AgentActionContract;
    providerContinuationId?: string;
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact) throw new Error("Plan revision not found");
    if (artifact.status !== "awaiting_approval") {
      throw new Error("Only a plan awaiting approval can be approved");
    }
    const actionContract = resolvePreResearchActionContract(
      artifact.contract,
      artifact.actionContract || params.actionContract,
    );
    if (
      artifact.actionContractId &&
      actionContract?.id !== artifact.actionContractId
    ) {
      throw new Error("The action contract changed after planning");
    }
    if (
      artifact.steps.some((step) => step.expectedEffect === "mutation") &&
      !actionContract &&
      artifact.contract?.effects?.libraryMutation.approval !== "after_research"
    ) {
      throw new Error(
        "This mutation plan has no frozen action contract and cannot be approved safely",
      );
    }
    const now = params.now ?? Date.now();
    const grant: ApprovedPlanGrant = {
      version: 1,
      planId: artifact.planId,
      revision: artifact.revision,
      planDigest: artifact.digest,
      conversationKey: artifact.conversationKey,
      conversationGeneration: params.conversationGeneration,
      actionContractId: artifact.actionContractId,
      approvedAt: now,
    };
    const executionId = makeId(
      `plan-execution-${artifact.planId}-r${artifact.revision}`,
    );
    const tasks: ExecutionTask[] = artifact.steps.map((step) => ({
      version: 2,
      taskId: `${executionId}:${step.planStepId}`,
      executionId,
      planStepId: step.planStepId,
      kind: "required_step",
      content: step.content,
      activeForm: step.activeForm,
      acceptanceCriteria: step.acceptanceCriteria,
      expectedEffect: step.expectedEffect,
      completionRequirements: step.completionRequirements,
      expectedCapability: step.expectedCapability,
      obligationIds:
        actionContract?.obligations
          .filter(
            (obligation) =>
              !step.expectedCapability ||
              obligation.capability === step.expectedCapability,
          )
          .map((obligation) => obligation.id) || [],
      status: "pending",
      attemptCount: 0,
      evidenceIds: [],
      failureReasons: [],
      createdAt: now,
      updatedAt: now,
    }));
    const approved: PlanArtifact = {
      ...artifact,
      status: "approved",
      approvedAt: now,
      updatedAt: now,
    };
    const ledger: PlanExecutionLedger = {
      version: 2,
      executionId,
      planId: artifact.planId,
      revision: artifact.revision,
      planDigest: artifact.digest,
      conversationKey: artifact.conversationKey,
      attempt: 1,
      provider: artifact.provider,
      providerContinuationId: params.providerContinuationId,
      actionContractId: artifact.actionContractId,
      grant,
      status: "pending",
      tasks,
      createdAt: now,
      updatedAt: now,
    };
    await Zotero.DB.executeTransaction(async () => {
      await savePlanArtifact(approved);
      await savePlanExecutionLedger(ledger, undefined, {
        alreadyInTransaction: true,
      });
      const investigation = artifact.contract?.investigation;
      const snapshotId = investigation?.scopeSnapshot?.snapshotId;
      if (investigation && snapshotId) {
        const parentTask = tasks.find((task) =>
          task.completionRequirements?.some(
            (requirement) => requirement.kind === "research_coverage",
          ),
        );
        if (!parentTask) {
          throw new Error(
            "A research plan requires a visible task that owns research coverage",
          );
        }
        const snapshotItems = await listScopeSnapshotItems(snapshotId);
        if (snapshotItems.length !== investigation.scopeSnapshot?.itemCount) {
          throw new Error("The approved research scope snapshot is incomplete");
        }
        const researchJobId = `${executionId}:research`;
        const policy =
          artifact.contract?.researchPolicy ||
          resolveResearchPolicy("plan_research");
        await saveResearchJob(
          {
            version: 1,
            researchJobId,
            executionId,
            parentTaskId: parentTask.taskId,
            contractDigest: artifact.contractDigest || artifact.digest,
            snapshotId,
            policy,
            status: "pending",
            activeStage: "inventory",
            totalItems: snapshotItems.length,
            screenedItems: 0,
            candidateItems: 0,
            deepReadCompleted: 0,
            deepReadPlanned: investigation.estimatedDeepReadPapers,
            createdAt: now,
            updatedAt: now,
          },
          artifact.conversationKey,
        );
        for (const snapshotItem of snapshotItems) {
          await saveResearchCorpusItem({
            version: 1,
            researchJobId,
            executionId,
            parentTaskId: parentTask.taskId,
            libraryID: snapshotItem.libraryID,
            itemKey: snapshotItem.itemKey,
            localItemId: snapshotItem.localItemId,
            ordinal: snapshotItem.ordinal,
            screeningStatus: "pending",
            criterionResults: {},
            inventoryRecorded: false,
            hasAbstract: false,
            attachmentItemKeys: [],
            duplicateAttachmentKeys: [],
            readable: Boolean(snapshotItem.attachmentFingerprint),
            indexed: false,
            sourceFingerprint:
              snapshotItem.attachmentFingerprint ||
              snapshotItem.metadataFingerprint,
            updatedAt: now,
          });
          await saveResearchWorkItem({
            version: 1,
            workItemId: `${researchJobId}:work:inventory:${snapshotItem.libraryID}:${snapshotItem.itemKey}`,
            researchJobId,
            executionId,
            parentTaskId: parentTask.taskId,
            libraryID: snapshotItem.libraryID,
            itemKey: snapshotItem.itemKey,
            stage: "inventory",
            subquestionIds: [],
            status: "pending",
            attemptCount: 0,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });
    return ledger;
  }

  async startNextTask(
    executionId: string,
    now = Date.now(),
  ): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    if (ledger.tasks.some((task) => task.status === "in_progress"))
      return ledger;
    const next = ledger.tasks.find(
      (task) => task.status === "pending" || task.status === "interrupted",
    );
    if (!next) return ledger;
    return this.requestTransition(
      {
        executionId,
        taskId: next.taskId,
        toStatus: "in_progress",
        requestedBy: "host",
      },
      now,
    );
  }

  async attachReceiptEvidence(params: {
    executionId: string;
    taskId: string;
    receipts: readonly AgentActionReceipt[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    const task = ledger.tasks.find((entry) => entry.taskId === params.taskId);
    if (!task) throw new Error("Execution task not found");
    const now = params.now ?? Date.now();
    const evidenceIds = [...task.evidenceIds];
    const requirement = task.completionRequirements?.find(
      (entry) => entry.kind === "mutation_receipts",
    );
    for (const receipt of params.receipts) {
      const evidenceId = `${params.executionId}:${params.taskId}:receipt:${receipt.id}`;
      const verified =
        receipt.verification === "verified" &&
        ["applied", "already_satisfied", "observed"].includes(receipt.status);
      const evidence: TaskEvidence = {
        version: requirement ? 3 : 1,
        evidenceId,
        executionId: params.executionId,
        taskId: params.taskId,
        kind: "mutation_receipt",
        verified,
        requirementId: requirement?.requirementId,
        criterionIds: requirement?.criterionIds,
        contractDigest: requirement?.contractDigest,
        receipt,
        payload: requirement
          ? { type: "mutation_receipts", receiptIds: [receipt.id] }
          : undefined,
        reference: receipt.evidenceRef,
        summary: receipt.verifiedFacts.join("; ") || receipt.reasons.join("; "),
        createdAt: now,
      };
      await saveTaskEvidence(evidence);
      if (!evidenceIds.includes(evidenceId)) evidenceIds.push(evidenceId);
    }
    const tasks = ledger.tasks.map((entry) =>
      entry.taskId === task.taskId
        ? { ...entry, evidenceIds, updatedAt: now }
        : entry,
    );
    const updated = { ...ledger, tasks, updatedAt: now };
    await savePlanExecutionLedger(updated);
    return updated;
  }

  async attachEvidence(evidence: TaskEvidence): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(evidence.executionId);
    const task = ledger.tasks.find((entry) => entry.taskId === evidence.taskId);
    if (!task) throw new Error("Execution task not found");
    await saveTaskEvidence(evidence);
    const evidenceIds = task.evidenceIds.includes(evidence.evidenceId)
      ? task.evidenceIds
      : [...task.evidenceIds, evidence.evidenceId];
    const tasks = ledger.tasks.map((entry) =>
      entry.taskId === task.taskId
        ? { ...entry, evidenceIds, updatedAt: evidence.createdAt }
        : entry,
    );
    const updated = { ...ledger, tasks, updatedAt: evidence.createdAt };
    await savePlanExecutionLedger(updated);
    return updated;
  }

  async requestTransition(
    request: TaskTransitionRequest,
    now = Date.now(),
  ): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(request.executionId);
    const task = ledger.tasks.find((entry) => entry.taskId === request.taskId);
    if (!task) throw new Error("Execution task not found");
    assertTaskTransitionRequest({ ledger, task, request });
    if (request.toStatus === "completed") {
      await this.assertCompletionEvidence(task);
    }
    const updatedTask: ExecutionTask = {
      ...task,
      status: request.toStatus,
      attemptCount:
        request.toStatus === "in_progress"
          ? task.attemptCount + 1
          : task.attemptCount,
      failureReasons:
        request.reason && ["blocked", "failed"].includes(request.toStatus)
          ? [...task.failureReasons, request.reason]
          : task.failureReasons,
      updatedAt: now,
      startedAt:
        request.toStatus === "in_progress"
          ? task.startedAt || now
          : task.startedAt,
      completedAt:
        request.toStatus === "completed" || request.toStatus === "skipped"
          ? now
          : task.completedAt,
    };
    const tasks = ledger.tasks.map((entry) =>
      entry.taskId === task.taskId ? updatedTask : entry,
    );
    const status = taskStatusAfterTransition(ledger, tasks);
    const terminal = [
      "completed",
      "completed_with_exceptions",
      "blocked",
      "failed",
      "cancelled",
    ].includes(status);
    const updated: PlanExecutionLedger = {
      ...ledger,
      tasks,
      status,
      activeTaskId:
        request.toStatus === "in_progress"
          ? task.taskId
          : ledger.activeTaskId === task.taskId
            ? undefined
            : ledger.activeTaskId,
      updatedAt: now,
      completedAt: terminal ? now : ledger.completedAt,
    };
    await savePlanExecutionLedger(updated, {
      taskId: task.taskId,
      fromStatus: task.status,
      toStatus: request.toStatus,
      payload: { requestedBy: request.requestedBy, reason: request.reason },
      createdAt: now,
    });
    return updated;
  }

  async assertCanFinalize(executionId: string): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    const unresolved = ledger.tasks.filter(
      (task) =>
        task.status !== "completed" &&
        !(task.kind === "required_step" && task.status === "skipped") &&
        !(task.kind === "supporting_child" && task.status === "cancelled"),
    );
    if (unresolved.length) {
      throw new Error(
        `Approved plan is not verified complete: ${unresolved
          .map((task) => `${task.content} (${task.status})`)
          .join(", ")}`,
      );
    }
    for (const task of ledger.tasks.filter(
      (entry) => entry.status === "completed",
    )) {
      await this.assertCompletionEvidence(task);
    }
    return ledger;
  }

  private async assertCompletionEvidence(task: ExecutionTask): Promise<void> {
    const evidence = await listTaskEvidence(task.executionId, task.taskId);
    assertTaskCompletionEvidence(task, evidence);
  }

  private async requireLedger(
    executionId: string,
  ): Promise<PlanExecutionLedger> {
    const ledger = await loadPlanExecutionLedger(executionId);
    if (!ledger) throw new Error("Plan execution ledger not found");
    return ledger;
  }
}

export const planExecutionCoordinator = new PlanExecutionCoordinator();
