import {
  validatePlanWorkflowBindings,
  planStepObligationIds,
} from "./workflowBindings";
import type {
  AgentActionContract,
  AgentActionReceipt,
} from "../contracts/types";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import {
  listTaskEvidence,
  loadPlanArtifact,
  loadOpenContractRevisionProposal,
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
import { resolvePlannedReadingPapers } from "../research/readingBudget";
import { resolveResearchPolicy } from "../research/policy";
import { withConversationWriteLock } from "../../shared/conversationWriteFence";

function normalizedText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

const CRITERION_VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "research_coverage",
  "material_integrity",
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

function assertExecutionMutable(ledger: PlanExecutionLedger): void {
  if (ledger.status === "superseded") {
    throw new Error(
      `Plan execution ${ledger.executionId} was superseded by ${ledger.supersededByExecutionId || "a successor"}`,
    );
  }
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
                  (!requirement.targetBoundary?.scopeDigest ||
                    entry.payload.scopeLineageDigest ===
                      requirement.targetBoundary.scopeDigest) &&
                  (entry.payload.coverageStatus === "complete" ||
                    entry.payload.coverageStatus ===
                      "complete_with_limitations")
                );
              }
              if (requirement.kind === "material_integrity") {
                return (
                  entry.kind === "material_integrity" &&
                  entry.payload?.type === "material_integrity" &&
                  entry.payload.integrityValidated &&
                  entry.payload.materialOutputId === task.materialOutputId
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
  nativePlanning?: import("./types").NativePlanBinding;
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

/** A planned deep read is a body-evidence promise, regardless of provider wording. */
export function canonicalizePlanResearchEvidenceDepth(
  contract: PlanContract,
): PlanContract {
  const investigation = contract.investigation;
  if (
    !investigation ||
    (investigation.readingStrategy !== "adaptive" &&
      investigation.estimatedDeepReadPapers <= 0) ||
    investigation.requiredEvidenceDepth === "body"
  ) {
    return contract;
  }
  return {
    ...contract,
    investigation: {
      ...investigation,
      requiredEvidenceDepth: "body",
    },
  };
}

/**
 * Completion verifier placement is a host contract, not a provider formatting
 * exercise. Preserve the model-authored criterion text and IDs while moving
 * research coverage to the final research step and document integrity and
 * publication to the final artifact step.
 */
export function canonicalizePlanVerifierOwnership(params: {
  contract: PlanContract;
  steps: readonly Omit<PlanStep, "completionRequirements">[];
}): Omit<PlanStep, "completionRequirements">[] {
  const steps = params.steps.map((step) => ({
    ...step,
    acceptanceCriteria: (
      step.acceptanceCriteria as readonly PlanAcceptanceCriterion[]
    ).map((criterion) => ({ ...criterion })),
  }));
  const existingIds = new Set(
    steps.flatMap((step) =>
      (step.acceptanceCriteria as readonly PlanAcceptanceCriterion[]).map(
        (criterion) => criterion.criterionId,
      ),
    ),
  );
  const uniqueId = (base: string) => {
    let id = base;
    let suffix = 2;
    while (existingIds.has(id)) id = `${base}-${suffix++}`;
    existingIds.add(id);
    return id;
  };
  const moveKinds = (
    kinds: readonly PlanCompletionRequirementKind[],
    ownerIndex: number,
    defaults: readonly PlanAcceptanceCriterion[],
  ) => {
    const selected: PlanAcceptanceCriterion[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const retained: PlanAcceptanceCriterion[] = [];
      for (const criterion of steps[index]
        .acceptanceCriteria as readonly PlanAcceptanceCriterion[]) {
        if (kinds.includes(criterion.verifier)) selected.push(criterion);
        else retained.push(criterion);
      }
      steps[index] = { ...steps[index], acceptanceCriteria: retained };
    }
    for (const fallback of defaults) {
      if (!selected.some((entry) => entry.verifier === fallback.verifier)) {
        selected.push({
          ...fallback,
          criterionId: uniqueId(fallback.criterionId),
        });
      }
    }
    steps[ownerIndex] = {
      ...steps[ownerIndex],
      acceptanceCriteria: [
        ...(steps[ownerIndex]
          .acceptanceCriteria as readonly PlanAcceptanceCriterion[]),
        ...selected,
      ],
    };
  };

  if (params.contract.investigation) {
    let researchOwner = -1;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (
        steps[index].expectedEffect === "read" ||
        steps[index].expectedEffect === "reasoning"
      ) {
        researchOwner = index;
        break;
      }
    }
    if (researchOwner < 0) {
      throw new Error("A research plan requires a read or reasoning step");
    }
    moveKinds(["research_coverage"], researchOwner, [
      {
        criterionId: "host-research-coverage",
        description:
          "The frozen corpus is durably screened and the approved evidence depth is complete",
        verifier: "research_coverage",
      },
    ]);
  }

  if (params.contract.deliverable.kind === "document") {
    const documentOwner = steps.length - 1;
    moveKinds(["document_integrity", "document_published"], documentOwner, [
      {
        criterionId: "host-document-integrity",
        description:
          "The finalized document satisfies the approved document contract",
        verifier: "document_integrity",
      },
      {
        criterionId: "host-document-published",
        description: "The finalized document is published to the conversation",
        verifier: "document_published",
      },
    ]);
  }
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].acceptanceCriteria.length) continue;
    const verifier: PlanCompletionRequirementKind =
      steps[index].expectedEffect === "read"
        ? "verified_read"
        : steps[index].expectedEffect === "mutation"
          ? "mutation_receipts"
          : "bounded_reasoning";
    steps[index] = {
      ...steps[index],
      acceptanceCriteria: [
        {
          criterionId: uniqueId(`host-step-${index + 1}`),
          description: `Verified completion of: ${steps[index].content}`,
          verifier,
        },
      ],
    };
  }
  return steps;
}

function requireFrozenWriteObligations(
  contract: AgentActionContract | undefined,
): void {
  if (!contract?.obligations.some((entry) => entry.operation !== "read_full")) {
    throw new Error(
      "This mutation plan has no frozen write obligations. Ask the user to state the requested action and exact targets explicitly, then revise the plan before approval.",
    );
  }
}

function validatePlanStepContract(params: {
  contract: PlanContract;
  steps: readonly PlanStep[];
}): void {
  const mutationIndexes = params.steps
    .map((step, index) => (step.expectedEffect === "mutation" ? index : -1))
    .filter((index) => index >= 0);
  const effect = params.contract.effects?.libraryMutation;
  if (effect?.approval === "initial")
    requireFrozenWriteObligations(effect.contract);
  if (Boolean(effect) !== Boolean(mutationIndexes.length)) {
    throw new Error(
      effect
        ? "A library-mutation contract requires a mutation plan step"
        : "A mutation plan step requires an approved library-mutation contract",
    );
  }
  validatePlanWorkflowBindings(params.contract, params.steps);
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
    assertExecutionMutable(ledger);
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
    assertExecutionMutable(ledger);
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
      actionIndexes?: readonly number[];
      materialOutputId?: string;
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
    nativePlanning?: import("./types").NativePlanBinding;
    skillRoutingReceipt?: PlanSkillRoutingReceipt;
    ready?: boolean;
    now?: number;
  }): Promise<PlanArtifact> {
    if (
      params.nativePlanning &&
      params.ready &&
      !params.nativePlanning.proposal?.markdown.trim()
    ) {
      throw new Error(
        "A completed native proposal is required before plan review",
      );
    }
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
    const decodedContract = canonicalizePlanResearchEvidenceDepth(
      decodePlanContract(
        params.contract ||
          buildDefaultPlanContract({
            actionContract: params.actionContract,
            steps: params.steps,
          }),
        { requireSnapshot: params.ready === true },
      ),
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
        actionIndexes: step.actionIndexes,
        materialOutputId: step.materialOutputId,
        targetBoundary: step.targetBoundary,
      };
    });
    const canonicalSteps = canonicalizePlanVerifierOwnership({
      contract: decodedContract,
      steps: normalizedSteps,
    });
    const steps = assignCompletionRequirements({
      steps: canonicalSteps,
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
      ...(params.nativePlanning
        ? { nativePlanning: params.nativePlanning }
        : {}),
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
      ...(params.nativePlanning
        ? { nativePlanning: params.nativePlanning }
        : {}),
      skillRoutingReceipt:
        params.skillRoutingReceipt || existing?.skillRoutingReceipt,
      contract: decodedContract,
      contractDigest,
      steps,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await this.supersedePriorDraft(params.planId, params.revision, now);
    await savePlanArtifact(artifact);
    if (params.ready && params.revision > 1) {
      const priorAmendment = await loadOpenContractRevisionProposal(
        params.planId,
      );
      if (priorAmendment && params.revision > priorAmendment.planRevision + 1) {
        const predecessor = await loadPlanExecutionLedger(
          priorAmendment.executionId,
        );
        if (
          !predecessor ||
          predecessor.planDigest !== priorAmendment.planDigest ||
          predecessor.planId !== params.planId
        ) {
          throw new Error(
            "The revised amendment no longer matches its predecessor execution",
          );
        }
        const { PlanAmendmentService } = await import("./amendments");
        const service = new PlanAmendmentService();
        const successor = await service.buildProposal({
          kind: "contract_revision",
          goalImpact: "contract_revision",
          planId: priorAmendment.planId,
          planRevision: priorAmendment.planRevision,
          planDigest: priorAmendment.planDigest,
          executionId: priorAmendment.executionId,
          executionDigest: priorAmendment.executionDigest,
          conversationKey: priorAmendment.conversationKey,
          previousScopeDigest: priorAmendment.previousScopeDigest,
          resultingScopeDigest: artifact.contractDigest || artifact.digest,
          targetSetDigest: await service.digest(
            artifact.contract?.investigation?.scope ||
              artifact.contract?.deliverable,
          ),
          proposalPayloadDigest: await service.digest({
            contract: artifact.contract,
            steps: artifact.steps,
          }),
          replacementContract: artifact.contract,
          replacementSteps: artifact.steps,
          replacementActionContract: actionContract,
          rationale:
            params.explanation ||
            "The reviewed successor Plan was revised before approval.",
          now,
        });
        await service.supersedeProposal(
          priorAmendment.proposalDigest,
          successor,
          now,
        );
      }
    }
    return artifact;
  }

  async supersedePriorDraft(
    planId: string,
    revision: number,
    now = Date.now(),
  ): Promise<void> {
    if (revision <= 1) return;
    const prior = await loadPlanArtifact(planId, revision - 1);
    if (
      prior &&
      (prior.status === "drafting" || prior.status === "awaiting_approval")
    ) {
      await savePlanArtifact({
        ...prior,
        status: "superseded",
        updatedAt: now,
      });
    }
  }

  async approve(params: {
    expectedDigest?: string;
    planId: string;
    revision: number;
    conversationGeneration: number;
    actionContract?: AgentActionContract;
    providerContinuationId?: string;
    authority?: ApprovedPlanGrant["authority"];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact) throw new Error("Plan revision not found");
    return withConversationWriteLock(artifact.conversationKey, () =>
      this.approveCurrent(params),
    );
  }

  private async approveCurrent(
    params: Parameters<PlanExecutionCoordinator["approve"]>[0],
  ): Promise<PlanExecutionLedger> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact) throw new Error("Plan revision not found");
    if (params.expectedDigest && artifact.digest !== params.expectedDigest)
      throw new Error("The plan changed after this review card was rendered");
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
      artifact.contract?.effects?.libraryMutation.approval !== "after_research"
    ) {
      requireFrozenWriteObligations(actionContract);
    }
    const now = params.now ?? Date.now();
    let amendmentService:
      | import("./amendments").PlanAmendmentService
      | undefined;
    let amendmentGrant:
      | import("./planAmendmentTypes").PlanAmendmentGrant
      | undefined;
    let predecessor: PlanExecutionLedger | null = null;
    if (artifact.revision > 1) {
      const amendment = await loadOpenContractRevisionProposal(artifact.planId);
      if (amendment) {
        const { PlanAmendmentService } = await import("./amendments");
        amendmentService = new PlanAmendmentService();
        predecessor = await loadPlanExecutionLedger(amendment.executionId);
        if (
          !predecessor ||
          predecessor.planId !== artifact.planId ||
          predecessor.revision !== amendment.planRevision ||
          predecessor.planDigest !== amendment.planDigest ||
          ["failed", "cancelled", "superseded"].includes(predecessor.status) ||
          predecessor.conversationKey !== artifact.conversationKey
        ) {
          throw new Error(
            "The contract revision no longer matches its predecessor execution",
          );
        }
        const proposalPayloadDigest = await amendmentService.digest({
          contract: artifact.contract,
          steps: artifact.steps,
        });
        if (
          amendment.kind !== "contract_revision" ||
          amendment.goalImpact !== "contract_revision" ||
          amendment.proposalPayloadDigest !== proposalPayloadDigest ||
          amendment.resultingScopeDigest !== artifact.contractDigest
        ) {
          throw new Error(
            "The reviewed Plan revision changed after its amendment proposal was recorded",
          );
        }
        if (
          amendment.executionDigest !==
          (await amendmentService.executionIdentityDigest(predecessor))
        ) {
          throw new Error(
            "The predecessor execution identity changed after the amendment was proposed",
          );
        }
        amendmentGrant = await amendmentService.authorize(
          amendment,
          params.authority || "user",
          now,
        );
      }
    }
    const grant: ApprovedPlanGrant = {
      version: 1,
      planId: artifact.planId,
      revision: artifact.revision,
      planDigest: artifact.digest,
      conversationKey: artifact.conversationKey,
      conversationGeneration: params.conversationGeneration,
      actionContractId: artifact.actionContractId,
      authority: params.authority || "user",
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
      actionIndexes: step.actionIndexes,
      materialOutputId: step.materialOutputId,
      completionRequirements: step.completionRequirements,
      expectedCapability: step.expectedCapability,
      obligationIds: planStepObligationIds(step, actionContract),
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
      providerContinuationId:
        params.providerContinuationId ||
        (artifact.nativePlanning && !artifact.nativePlanning.ephemeral
          ? artifact.nativePlanning.threadId
          : undefined),
      actionContractId: artifact.actionContractId,
      grant,
      status: "pending",
      tasks,
      createdAt: now,
      updatedAt: now,
    };
    let approvedLedger = ledger;
    try {
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
            throw new Error(
              "The approved research scope snapshot is incomplete",
            );
          }
          const researchJobId = `${executionId}:research`;
          const policy =
            artifact.contract?.researchPolicy ||
            resolveResearchPolicy("plan_research");
          await saveResearchJob(
            {
              version: 2,
              researchJobId,
              executionId,
              parentTaskId: parentTask.taskId,
              contractDigest: artifact.contractDigest || artifact.digest,
              baseSnapshotId: snapshotId,
              snapshotId,
              scopeLineageDigest: investigation.scopeSnapshot!.digest,
              policy,
              status: "pending",
              activeStage: "inventory",
              totalItems: snapshotItems.length,
              screenedItems: 0,
              candidateItems: 0,
              deepReadCompleted: 0,
              deepReadPlanned: resolvePlannedReadingPapers(
                investigation,
                snapshotItems.length,
              ),
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
        if (
          amendmentService &&
          amendmentGrant &&
          predecessor &&
          predecessor.status !== "superseded"
        ) {
          await amendmentService.migrateSuccessorExecutionState({
            predecessorExecutionId: predecessor.executionId,
            successorExecutionId: ledger.executionId,
            now,
            alreadyInTransaction: true,
          });
          approvedLedger = (
            await this.supersedeExecution({
              executionId: predecessor.executionId,
              successorExecutionId: ledger.executionId,
              now,
              alreadyInTransaction: true,
            })
          ).successor;
          amendmentGrant = await amendmentService.markApplied(
            amendmentGrant,
            now,
          );
        }
      });
    } catch (error) {
      if (amendmentService && amendmentGrant) {
        await amendmentService.markFailed(amendmentGrant, error, now);
      }
      throw error;
    }
    return approvedLedger;
  }

  async supersedeExecution(params: {
    executionId: string;
    successorExecutionId: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<{
    superseded: PlanExecutionLedger;
    successor: PlanExecutionLedger;
  }> {
    if (params.executionId === params.successorExecutionId) {
      throw new Error("An execution cannot supersede itself");
    }
    const [current, successor] = await Promise.all([
      this.requireLedger(params.executionId),
      this.requireLedger(params.successorExecutionId),
    ]);
    if (
      current.planId !== successor.planId ||
      successor.revision <= current.revision
    ) {
      throw new Error("A successor execution must use a later Plan revision");
    }
    const now = params.now ?? Date.now();
    const superseded: PlanExecutionLedger = {
      ...current,
      status: "superseded",
      activeTaskId: undefined,
      supersededByExecutionId: successor.executionId,
      updatedAt: now,
      completedAt: now,
    };
    const linkedSuccessor: PlanExecutionLedger = {
      ...successor,
      predecessorExecutionId: current.executionId,
      updatedAt: now,
    };
    const priorArtifact = await loadPlanArtifact(
      current.planId,
      current.revision,
    );
    const write = async () => {
      await savePlanExecutionLedger(superseded, undefined, {
        alreadyInTransaction: true,
      });
      await savePlanExecutionLedger(linkedSuccessor, undefined, {
        alreadyInTransaction: true,
      });
      if (priorArtifact) {
        await savePlanArtifact({
          ...priorArtifact,
          status: "superseded",
          updatedAt: now,
        });
      }
    };
    if (params.alreadyInTransaction) await write();
    else await Zotero.DB.executeTransaction(write);
    return { superseded, successor: linkedSuccessor };
  }

  async startNextTask(
    executionId: string,
    now = Date.now(),
  ): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    assertExecutionMutable(ledger);
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

  async reopenForScopeAmendment(params: {
    executionId: string;
    scopeLineageDigest: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    const now = params.now ?? Date.now();
    const earliestAffected = ledger.tasks.findIndex((task) =>
      task.completionRequirements?.some((requirement) =>
        ["verified_read", "research_coverage"].includes(requirement.kind),
      ),
    );
    if (earliestAffected < 0) {
      throw new Error(
        "The execution has no host-owned research task to reopen",
      );
    }
    const suffix = params.scopeLineageDigest
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-16);
    const tasks: ExecutionTask[] = ledger.tasks.map((task, index) => {
      if (index < earliestAffected) return task;
      const preservesVerifiedEffect =
        task.expectedEffect === "mutation" && task.status === "completed";
      if (preservesVerifiedEffect) return task;
      const completionRequirements = task.completionRequirements?.map(
        (requirement) => ({
          ...requirement,
          requirementId: `${requirement.requirementId}:scope:${suffix}`,
          targetBoundary:
            requirement.kind === "research_coverage"
              ? {
                  ...(requirement.targetBoundary || {}),
                  scopeDigest: params.scopeLineageDigest,
                }
              : requirement.targetBoundary,
        }),
      );
      return {
        ...task,
        status: index === earliestAffected ? "in_progress" : "pending",
        attemptCount:
          index === earliestAffected
            ? task.attemptCount + 1
            : task.attemptCount,
        evidenceIds: [],
        failureReasons: [],
        completionRequirements,
        startedAt: index === earliestAffected ? now : undefined,
        completedAt: undefined,
        updatedAt: now,
      };
    });
    const updated: PlanExecutionLedger = {
      ...ledger,
      status: "running",
      activeTaskId: tasks[earliestAffected].taskId,
      tasks,
      completedAt: undefined,
      updatedAt: now,
    };
    await savePlanExecutionLedger(updated, undefined, {
      alreadyInTransaction: params.alreadyInTransaction,
    });
    return updated;
  }

  /**
   * Advance consecutive tasks whose complete contracts are already satisfied
   * by host-issued evidence. Research tools call this at durable boundaries so
   * the model never has to mirror verified host state through task_update.
   */
  async advanceVerifiedTasks(params: {
    executionId: string;
    requirementKinds: readonly PlanCompletionRequirementKind[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const allowed = new Set(params.requirementKinds);
    let ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    let now = params.now ?? Date.now();

    while (true) {
      if (!ledger.tasks.some((task) => task.status === "in_progress")) {
        ledger = await this.startNextTask(params.executionId, now);
      }
      const active = ledger.tasks.find(
        (task) => task.taskId === ledger.activeTaskId,
      );
      if (!active || active.status !== "in_progress") return ledger;
      const requirements = active.completionRequirements || [];
      if (
        !requirements.length ||
        requirements.some((requirement) => !allowed.has(requirement.kind))
      ) {
        return ledger;
      }
      try {
        await this.assertCompletionEvidence(active);
      } catch {
        return ledger;
      }
      ledger = await this.requestTransition(
        {
          executionId: params.executionId,
          taskId: active.taskId,
          toStatus: "completed",
          requestedBy: "host",
        },
        now,
      );
      now += 1;
    }
  }

  async attachReceiptEvidence(params: {
    executionId: string;
    taskId: string;
    receipts: readonly AgentActionReceipt[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
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
    assertExecutionMutable(ledger);
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
    options: { alreadyInTransaction?: boolean } = {},
  ): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(request.executionId);
    assertExecutionMutable(ledger);
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
    await savePlanExecutionLedger(
      updated,
      {
        taskId: task.taskId,
        fromStatus: task.status,
        toStatus: request.toStatus,
        payload: { requestedBy: request.requestedBy, reason: request.reason },
        createdAt: now,
      },
      options,
    );
    return updated;
  }

  /** Commits host-validated evidence and its single task transition as one
   * transaction. This is used for bounded reasoning, whose evidence is born
   * in the same task_update call and must never survive a rolled-back status
   * change on its own. */
  async requestTransitionWithEvidence(params: {
    request: TaskTransitionRequest;
    evidence: TaskEvidence;
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const now = params.now ?? Date.now();
    const ledger = await this.requireLedger(params.request.executionId);
    assertExecutionMutable(ledger);
    const task = ledger.tasks.find(
      (entry) => entry.taskId === params.request.taskId,
    );
    if (!task) throw new Error("Execution task not found");
    if (
      params.evidence.executionId !== ledger.executionId ||
      params.evidence.taskId !== task.taskId ||
      !params.evidence.verified
    ) {
      throw new Error("Transition evidence does not match the active task");
    }
    assertTaskTransitionRequest({ ledger, task, request: params.request });
    const evidenceIds = task.evidenceIds.includes(params.evidence.evidenceId)
      ? task.evidenceIds
      : [...task.evidenceIds, params.evidence.evidenceId];
    const taskWithEvidence: ExecutionTask = {
      ...task,
      evidenceIds,
      updatedAt: now,
    };
    if (params.request.toStatus === "completed") {
      const persistedEvidence = await listTaskEvidence(
        ledger.executionId,
        task.taskId,
      );
      assertTaskCompletionEvidence(taskWithEvidence, [
        ...persistedEvidence,
        params.evidence,
      ]);
    }
    const updatedTask: ExecutionTask = {
      ...taskWithEvidence,
      status: params.request.toStatus,
      attemptCount:
        params.request.toStatus === "in_progress"
          ? task.attemptCount + 1
          : task.attemptCount,
      failureReasons:
        params.request.reason &&
        ["blocked", "failed"].includes(params.request.toStatus)
          ? [...task.failureReasons, params.request.reason]
          : task.failureReasons,
      startedAt:
        params.request.toStatus === "in_progress"
          ? task.startedAt || now
          : task.startedAt,
      completedAt:
        params.request.toStatus === "completed" ||
        params.request.toStatus === "skipped"
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
        params.request.toStatus === "in_progress"
          ? task.taskId
          : ledger.activeTaskId === task.taskId
            ? undefined
            : ledger.activeTaskId,
      updatedAt: now,
      completedAt: terminal ? now : ledger.completedAt,
    };
    await Zotero.DB.executeTransaction(async () => {
      await saveTaskEvidence(params.evidence);
      await savePlanExecutionLedger(
        updated,
        {
          taskId: task.taskId,
          fromStatus: task.status,
          toStatus: params.request.toStatus,
          payload: {
            requestedBy: params.request.requestedBy,
            reason: params.request.reason,
            evidenceId: params.evidence.evidenceId,
          },
          createdAt: now,
        },
        { alreadyInTransaction: true },
      );
    });
    return updated;
  }

  async assertCanFinalize(executionId: string): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    assertExecutionMutable(ledger);
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
