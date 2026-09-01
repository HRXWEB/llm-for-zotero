import type {
  AgentEvent,
  AgentRuntimeRequest,
  AgentToolArtifact,
  AgentToolResult,
} from "../types";
import { loadPlanArtifact, loadPlanExecutionLedger } from "./store";
import { planExecutionCoordinator } from "./coordinator";
import type { PlanExecutionLedger, PlanEvent, TaskEvidence } from "./types";
import type { PlanRuntimeContext } from "./types";
import type { ZoteroMcpToolActivityEvent } from "../mcp/server";

export async function recordMcpPlanEvidence(
  plan: PlanRuntimeContext | undefined,
  event: ZoteroMcpToolActivityEvent,
  options: { autoAdvance?: boolean } = {},
): Promise<PlanExecutionLedger | null> {
  if (plan?.phase !== "executing" || event.phase !== "completed" || !event.ok) {
    return null;
  }
  let ledger = await loadPlanExecutionLedger(plan.executionId);
  const taskId = ledger?.activeTaskId;
  if (!ledger || !taskId) return null;
  if (event.actionReceipts?.length) {
    ledger = await planExecutionCoordinator.attachReceiptEvidence({
      executionId: plan.executionId,
      taskId,
      receipts: event.actionReceipts,
    });
  }
  const evidence = async (
    kind: TaskEvidence["kind"],
    reference: string,
    summary: string,
  ) => {
    ledger = await planExecutionCoordinator.attachEvidence({
      version: 1,
      evidenceId: `${plan.executionId}:${taskId}:${kind}:${event.requestId}`,
      executionId: plan.executionId,
      taskId,
      kind,
      verified: true,
      reference,
      summary,
      createdAt: event.timestamp,
    });
  };
  if (event.mutability === "read") {
    await evidence(
      "verified_read",
      `mcp:${event.requestId}`,
      `Verified ${event.toolName} result`,
    );
  }
  if (event.artifacts?.length) {
    await evidence(
      "artifact",
      `mcp:${event.requestId}:artifacts`,
      `${event.artifacts.length} durable artifact${event.artifacts.length === 1 ? "" : "s"}`,
    );
  }
  if (options.autoAdvance) {
    try {
      ledger = await planExecutionCoordinator.requestTransition({
        executionId: plan.executionId,
        taskId,
        toStatus: "completed",
        requestedBy: plan.provider,
        reason: `Verified ${event.toolName} evidence`,
      });
      ledger = await planExecutionCoordinator.startNextTask(plan.executionId);
    } catch {
      // Evidence may be partial for the active acceptance criteria. Keep the
      // task active until another verified result or provider transition.
    }
  }
  return ledger;
}

export type PlanFinalDecision =
  | { kind: "accept" }
  | { kind: "correct"; correction: string }
  | { kind: "fail"; failure: string };

export class PlanExecutionRunSession {
  private correctionUsed = false;
  private ledger: PlanExecutionLedger | null = null;

  constructor(
    private readonly request: AgentRuntimeRequest,
    private readonly emit: (event: AgentEvent) => Promise<void>,
  ) {}

  async initialize(): Promise<
    { kind: "ready" } | { kind: "failed"; userMessage: string }
  > {
    const plan = this.request.planContext;
    if (!plan) return { kind: "ready" };
    if (plan.phase === "planning") {
      const existing = await loadPlanArtifact(plan.planId, plan.revision);
      if (existing?.status === "approved") {
        return {
          kind: "failed",
          userMessage: "This plan revision is already approved and immutable.",
        };
      }
      return { kind: "ready" };
    }
    const ledger = await loadPlanExecutionLedger(plan.executionId);
    if (!ledger) {
      return {
        kind: "failed",
        userMessage: "The approved plan execution ledger could not be loaded.",
      };
    }
    if (
      ledger.planId !== plan.planId ||
      ledger.revision !== plan.revision ||
      ledger.planDigest !== plan.approvedDigest ||
      ledger.conversationKey !== this.request.conversationKey
    ) {
      return {
        kind: "failed",
        userMessage:
          "The approved plan identity no longer matches this conversation.",
      };
    }
    this.ledger = await planExecutionCoordinator.startNextTask(
      plan.executionId,
    );
    this.request.planContext = {
      ...plan,
      activeTaskId: this.ledger.activeTaskId,
    };
    await this.publish({ type: "plan_execution_updated", ledger: this.ledger });
    return { kind: "ready" };
  }

  async recordToolResult(params: {
    toolName: string;
    mutability?: "read" | "write";
    result: AgentToolResult;
    artifacts?: AgentToolArtifact[];
    runId: string;
  }): Promise<void> {
    const plan = this.request.planContext;
    if (!plan || plan.phase !== "executing") return;
    let ledger =
      this.ledger || (await loadPlanExecutionLedger(plan.executionId));
    const taskId = ledger?.activeTaskId;
    if (!ledger || !taskId) return;
    if (params.result.actionReceipts.length) {
      ledger = await planExecutionCoordinator.attachReceiptEvidence({
        executionId: plan.executionId,
        taskId,
        receipts: params.result.actionReceipts,
      });
    }
    if (params.result.ok && params.mutability === "read") {
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "verified_read",
          verified: true,
          reference: `${params.runId}:${params.result.callId}`,
          summary: `Verified result from ${params.toolName}`,
        }),
      );
    }
    if (params.result.ok && params.artifacts?.length) {
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "artifact",
          verified: true,
          reference: `${params.runId}:${params.result.callId}:artifacts`,
          summary: `${params.artifacts.length} durable artifact${params.artifacts.length === 1 ? "" : "s"}`,
        }),
      );
    }
    this.ledger = ledger;
    await this.publish({ type: "plan_execution_updated", ledger });
  }

  async evaluateFinal(params: {
    canCorrect: boolean;
  }): Promise<PlanFinalDecision> {
    const plan = this.request.planContext;
    if (!plan) return { kind: "accept" };
    if (plan.phase === "planning") {
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      if (artifact?.status === "awaiting_approval") {
        await this.publish({ type: "plan_ready", artifact });
        return { kind: "accept" };
      }
      const correction =
        "Finish the planning phase by calling update_plan with objective acceptance criteria for every step and ready=true. Do not execute any mutation.";
      if (params.canCorrect && !this.correctionUsed) {
        this.correctionUsed = true;
        return { kind: "correct", correction };
      }
      return {
        kind: "fail",
        failure: "The provider stopped before producing a reviewable plan.",
      };
    }
    try {
      this.ledger = await planExecutionCoordinator.assertCanFinalize(
        plan.executionId,
      );
      await this.publish({
        type: "plan_execution_updated",
        ledger: this.ledger,
      });
      return { kind: "accept" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (params.canCorrect && !this.correctionUsed) {
        this.correctionUsed = true;
        return {
          kind: "correct",
          correction: `${message}. Continue the approved plan. Use task_update only after the current task has verified evidence; do not claim completion from model judgment alone.`,
        };
      }
      return { kind: "fail", failure: message };
    }
  }

  private makeEvidence(
    params: Omit<TaskEvidence, "version" | "evidenceId" | "createdAt">,
  ): TaskEvidence {
    const createdAt = Date.now();
    return {
      version: 1,
      evidenceId: `${params.executionId}:${params.taskId}:${params.kind}:${createdAt}:${Math.random().toString(36).slice(2, 7)}`,
      ...params,
      createdAt,
    };
  }

  private async publish(event: PlanEvent): Promise<void> {
    await this.emit(event);
  }
}
