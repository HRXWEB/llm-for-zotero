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
  PlanExecutionLedger,
  PlanProvider,
  PlanStep,
  TaskEvidence,
  TaskTransitionRequest,
} from "./types";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";

function normalizedText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
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
      "cancelled",
    ],
    waiting_for_user: ["in_progress", "blocked", "cancelled"],
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
  const verified = evidence.filter((entry) => entry.verified);
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

export async function computePlanDigest(params: {
  planId: string;
  conversationKey: number;
  revision: number;
  actionContractId?: string;
  steps: readonly PlanStep[];
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
}): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(params))}`;
}

export class PlanExecutionCoordinator {
  async admitSupportingTask(params: {
    executionId: string;
    taskId: string;
    parentTaskId: string;
    content: string;
    activeForm?: string;
    acceptanceCriteria: readonly string[];
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
    const child: ExecutionTask = {
      version: 1,
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
      acceptanceCriteria: params.acceptanceCriteria
        .map((criterion) => criterion.trim())
        .filter(Boolean),
      expectedEffect: params.expectedEffect,
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
      acceptanceCriteria: readonly string[];
      expectedCapability?: string;
      expectedEffect: PlanStep["expectedEffect"];
      targetBoundary?: PlanStep["targetBoundary"];
    }>;
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
    const seen = new Set<string>();
    const steps: PlanStep[] = params.steps.map((step, index) => {
      const planStepId =
        step.planStepId?.trim() ||
        `${params.planId}:r${params.revision}:s${index + 1}`;
      if (seen.has(planStepId))
        throw new Error(`Duplicate planStepId: ${planStepId}`);
      seen.add(planStepId);
      const acceptanceCriteria = step.acceptanceCriteria
        .map((criterion) => criterion.trim())
        .filter(Boolean);
      if (!acceptanceCriteria.length) {
        throw new Error(`Plan step ${index + 1} requires acceptance criteria`);
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
    const digest = await computePlanDigest({
      planId: params.planId,
      conversationKey: params.conversationKey,
      revision: params.revision,
      actionContractId: params.actionContractId,
      steps,
      skillRoutingReceipt: params.skillRoutingReceipt,
    });
    const artifact: PlanArtifact = {
      version: 2,
      planId: params.planId,
      conversationKey: params.conversationKey,
      provider: params.provider,
      revision: params.revision,
      digest,
      status: params.ready ? "awaiting_approval" : "drafting",
      explanation: params.explanation?.trim() || undefined,
      actionContractId: params.actionContractId,
      actionContract: params.actionContract,
      sourceRunId: params.sourceRunId || existing?.sourceRunId,
      skillRoutingReceipt:
        params.skillRoutingReceipt || existing?.skillRoutingReceipt,
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
    const actionContract = artifact.actionContract || params.actionContract;
    if (
      artifact.actionContractId &&
      actionContract?.id !== artifact.actionContractId
    ) {
      throw new Error("The action contract changed after planning");
    }
    if (
      artifact.steps.some((step) => step.expectedEffect === "mutation") &&
      !actionContract
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
      version: 1,
      taskId: `${executionId}:${step.planStepId}`,
      executionId,
      planStepId: step.planStepId,
      kind: "required_step",
      content: step.content,
      activeForm: step.activeForm,
      acceptanceCriteria: step.acceptanceCriteria,
      expectedEffect: step.expectedEffect,
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
      version: 1,
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
    for (const receipt of params.receipts) {
      const evidenceId = `${params.executionId}:${params.taskId}:receipt:${receipt.id}`;
      const verified =
        receipt.verification === "verified" &&
        ["applied", "already_satisfied", "observed"].includes(receipt.status);
      const evidence: TaskEvidence = {
        version: 1,
        evidenceId,
        executionId: params.executionId,
        taskId: params.taskId,
        kind: "mutation_receipt",
        verified,
        receipt,
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
