import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  ExecutionTaskStatus,
} from "../../types";
import { planExecutionCoordinator } from "../../plans/coordinator";
import { listTaskEvidence } from "../../plans/store";
import type {
  PlanAcceptanceCriterion,
  PlanCompletionRequirementKind,
  TaskEvidence,
} from "../../plans/types";
import { fail, ok, validateObject } from "../shared";

type TaskUpdateRequest = {
  taskId: string;
  status: ExecutionTaskStatus;
  parentTaskId?: string;
  content?: string;
  activeForm?: string;
  acceptanceCriteria?: PlanAcceptanceCriterion[];
  expectedEffect?: "read" | "artifact" | "mutation" | "reasoning";
  expectedCapability?: string;
  targetIds?: string[];
  reason?: string;
  reasoningAssertion?: string;
};

type TaskUpdateInput = { task: TaskUpdateRequest };

const STATUSES = new Set<ExecutionTaskStatus>([
  "pending",
  "in_progress",
  "waiting_for_user",
  "interrupted",
  "completed",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);
const VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "research_coverage",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "bounded_reasoning",
  "user_decision",
]);

function validateTaskUpdateInput(
  args: unknown,
): AgentToolInputValidation<TaskUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("task_update expects an object");
  }
  if (Array.isArray(args.tasks)) {
    return fail(
      "task_update accepts exactly one transition in task; submit later transitions in separate calls",
    );
  }
  const raw = args.task;
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail("task_update.task must be an object");
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  const status = raw.status as ExecutionTaskStatus;
  if (!taskId || !STATUSES.has(status)) {
    return fail("task_update.task has an invalid identity/status");
  }
  const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
    ? raw.acceptanceCriteria.flatMap((value) => {
        if (!validateObject<Record<string, unknown>>(value)) return [];
        const criterionId =
          typeof value.criterionId === "string" ? value.criterionId.trim() : "";
        const description =
          typeof value.description === "string" ? value.description.trim() : "";
        const verifier = value.verifier as PlanCompletionRequirementKind;
        return criterionId && description && VERIFIERS.has(verifier)
          ? [{ criterionId, description, verifier }]
          : [];
      })
    : undefined;
  if (
    Array.isArray(raw.acceptanceCriteria) &&
    acceptanceCriteria?.length !== raw.acceptanceCriteria.length
  ) {
    return fail("task_update.task.acceptanceCriteria is invalid");
  }
  const task: TaskUpdateRequest = {
    taskId,
    status,
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim()
        : undefined,
    reasoningAssertion:
      typeof raw.reasoningAssertion === "string" &&
      raw.reasoningAssertion.trim()
        ? raw.reasoningAssertion.trim()
        : undefined,
    parentTaskId:
      typeof raw.parentTaskId === "string"
        ? raw.parentTaskId.trim() || undefined
        : undefined,
    content:
      typeof raw.content === "string"
        ? raw.content.trim() || undefined
        : undefined,
    activeForm:
      typeof raw.activeForm === "string"
        ? raw.activeForm.trim() || undefined
        : undefined,
    acceptanceCriteria,
    expectedEffect: ["read", "artifact", "mutation", "reasoning"].includes(
      String(raw.expectedEffect || ""),
    )
      ? (raw.expectedEffect as TaskUpdateRequest["expectedEffect"])
      : undefined,
    expectedCapability:
      typeof raw.expectedCapability === "string"
        ? raw.expectedCapability.trim() || undefined
        : undefined,
    targetIds: Array.isArray(raw.targetIds)
      ? raw.targetIds.map(String).filter(Boolean)
      : undefined,
  };
  return ok({ task });
}

export function createTaskUpdateTool(): AgentToolDefinition<
  TaskUpdateInput,
  unknown
> {
  return {
    spec: {
      name: "task_update",
      description:
        "Apply exactly one task transition in the approved plan. Use the immutable task ID; the host validates and commits the transition before automatically starting the next pending step. Completing a reasoning task requires reasoningAssertion in the same update.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "status"],
            properties: {
              taskId: { type: "string" },
              status: {
                type: "string",
                enum: Array.from(STATUSES),
              },
              reason: { type: "string" },
              reasoningAssertion: {
                type: "string",
                description:
                  "Required when completing a reasoning task. State the bounded conclusion that satisfies the approved acceptance criteria; this becomes verified reasoning evidence.",
              },
              parentTaskId: { type: "string" },
              content: { type: "string" },
              activeForm: { type: "string" },
              acceptanceCriteria: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["criterionId", "description", "verifier"],
                  properties: {
                    criterionId: { type: "string" },
                    description: { type: "string" },
                    verifier: {
                      type: "string",
                      enum: Array.from(VERIFIERS),
                    },
                  },
                },
              },
              expectedEffect: {
                type: "string",
                enum: ["read", "artifact", "mutation", "reasoning"],
              },
              expectedCapability: { type: "string" },
              targetIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "Execute the approved plan in order. The host starts the active task and owns the authoritative ledger. Call task_update with exactly one task transition, using the immutable taskId from the approved-plan context. Existing tasks normally need only taskId and status, but when completing a task whose expectedEffect is reasoning or whose completion requirement is bounded_reasoning, include reasoningAssertion in that same update; otherwise completion is rejected. Wait for that call to commit before submitting another transition. A completed request is rejected unless receipts or verified evidence satisfy the task; after completion the host starts the next pending task. Never rename, delete, reorder, or silently skip an approved task.",
    },
    validate: validateTaskUpdateInput,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error(
          "task_update is available only during approved execution",
        );
      }
      let ledger = await planExecutionCoordinator.startNextTask(
        plan.executionId,
      );
      const request = input.task;
      let current = ledger.tasks.find((task) => task.taskId === request.taskId);
      let admittedSupportingTask = false;
      if (!current) {
        if (
          request.status !== "pending" ||
          !request.parentTaskId ||
          !request.content ||
          !request.acceptanceCriteria?.length ||
          !request.expectedEffect
        ) {
          throw new Error(
            "New supporting tasks require parent, immutable presentation, evidence policy, and pending status",
          );
        }
        ledger = await planExecutionCoordinator.admitSupportingTask({
          executionId: plan.executionId,
          taskId: request.taskId,
          parentTaskId: request.parentTaskId,
          content: request.content,
          activeForm: request.activeForm,
          acceptanceCriteria: request.acceptanceCriteria,
          expectedEffect: request.expectedEffect,
          expectedCapability: request.expectedCapability,
          targetIds: request.targetIds,
        });
        admittedSupportingTask = true;
        current = ledger.tasks.find((task) => task.taskId === request.taskId);
      }
      if (!current) throw new Error(`Unknown taskId: ${request.taskId}`);
      let transitionEvidence: TaskEvidence | undefined;
      if (request.reasoningAssertion) {
        if (request.status !== "completed") {
          throw new Error(
            "A reasoning assertion must accompany a completed transition",
          );
        }
        const requirement = current.completionRequirements?.find(
          (entry) => entry.kind === "bounded_reasoning",
        );
        if (!requirement) {
          throw new Error(
            "Reasoning assertions may attest only criteria declared with the bounded_reasoning verifier",
          );
        }
        transitionEvidence = {
          version: requirement ? 3 : 1,
          evidenceId: `${plan.executionId}:${request.taskId}:reasoning:${Date.now()}`,
          executionId: plan.executionId,
          taskId: request.taskId,
          kind: "reasoning_assertion",
          verified: true,
          requirementId: requirement?.requirementId,
          criterionIds: requirement?.criterionIds,
          contractDigest: requirement?.contractDigest,
          payload: requirement
            ? {
                type: "bounded_reasoning",
                assertion: request.reasoningAssertion,
              }
            : undefined,
          summary: request.reasoningAssertion,
          createdAt: Date.now(),
        };
      }
      const latest = ledger.tasks.find(
        (task) => task.taskId === request.taskId,
      );
      if (
        latest &&
        latest.status === request.status &&
        !admittedSupportingTask
      ) {
        throw new Error(
          `Task ${request.taskId} is already ${request.status}; task_update requires a status transition`,
        );
      }
      if (latest && latest.status !== request.status) {
        const requestedBy =
          request.status === "skipped" && latest.expectedEffect === "mutation"
            ? (await listTaskEvidence(plan.executionId, request.taskId)).some(
                (entry) =>
                  entry.verified &&
                  entry.kind === "validation" &&
                  entry.reference?.startsWith("user-declined:"),
              )
              ? "user"
              : plan.provider
            : plan.provider;
        const transitionRequest = {
          executionId: plan.executionId,
          taskId: request.taskId,
          toStatus: request.status,
          reason: request.reason,
          requestedBy,
        } as const;
        ledger = transitionEvidence
          ? await planExecutionCoordinator.requestTransitionWithEvidence({
              request: transitionRequest,
              evidence: transitionEvidence,
            })
          : await planExecutionCoordinator.requestTransition(transitionRequest);
      }
      if (ledger.status === "running" || ledger.status === "pending") {
        ledger = await planExecutionCoordinator.startNextTask(plan.executionId);
      }
      await context.publishPlanEvent?.({
        type: "plan_execution_updated",
        ledger,
      });
      return { ledger };
    },
  };
}
