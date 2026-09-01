import type {
  AgentPendingAction,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { loadPlanArtifact } from "../../plans/store";
import { shouldCheckpointResearchExpansion } from "../../research/policy";
import {
  loadResearchJobForExecution,
  saveResearchJob,
} from "../../research/store";
import type { ResearchProgress } from "../../research/types";
import { fail, ok, validateObject } from "../shared";

type ApproveResearchExpansionInput = {
  proposedDeepReadCeiling: number;
  reason: string;
};

function validateInput(
  args: unknown,
): AgentToolInputValidation<ApproveResearchExpansionInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("approve_research_expansion expects an object");
  }
  if (
    !Number.isInteger(args.proposedDeepReadCeiling) ||
    Number(args.proposedDeepReadCeiling) < 1
  ) {
    return fail("proposedDeepReadCeiling must be a positive integer");
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return fail("reason is required");
  return ok({
    proposedDeepReadCeiling: Number(args.proposedDeepReadCeiling),
    reason,
  });
}

function pendingAction(
  input: ApproveResearchExpansionInput,
): AgentPendingAction {
  return {
    toolName: "approve_research_expansion",
    title: "Research scope expanded",
    description:
      `${input.reason}\n\nContinue deep reading up to ` +
      `${input.proposedDeepReadCeiling} candidate papers?`,
    confirmLabel: "Continue research",
    cancelLabel: "Keep current limit",
    fields: [
      {
        type: "text",
        id: "deepReadCeiling",
        label: "Proposed deep-read ceiling",
        value: String(input.proposedDeepReadCeiling),
      },
    ],
  };
}

function progress(
  job: NonNullable<Awaited<ReturnType<typeof loadResearchJobForExecution>>>,
): ResearchProgress {
  return {
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    stage: job.activeStage,
    totalItems: job.totalItems,
    screenedItems: job.screenedItems,
    candidateItems: job.candidateItems,
    deepReadCompleted: job.deepReadCompleted,
    deepReadPlanned: job.deepReadPlanned,
    coverageStatus: job.coverageStatus,
  };
}

export function createApproveResearchExpansionTool(): AgentToolDefinition<
  ApproveResearchExpansionInput,
  unknown
> {
  return {
    spec: {
      name: "approve_research_expansion",
      description:
        "Request the required user checkpoint when screening finds materially more deep-read candidates than the approved estimate. This changes only the research ceiling, never the Zotero library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["proposedDeepReadCeiling", "reason"],
        properties: {
          proposedDeepReadCeiling: { type: "number" },
          reason: { type: "string" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
      interaction: "user_input",
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "When research_update reports checkpointRequired, stop deep reading and call approve_research_expansion. Do not raise the ceiling through research_update. If approval is declined, either finalize a partial result at the user's direction or revise the plan to narrow scope.",
    },
    validate: validateInput,
    planMutation: () => ({ effect: "none", reversibility: "none" }),
    shouldRequireConfirmation: () => true,
    createPendingAction: pendingAction,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error("Research expansion requires approved plan execution");
      }
      const [job, artifact] = await Promise.all([
        loadResearchJobForExecution(plan.executionId),
        loadPlanArtifact(plan.planId, plan.revision),
      ]);
      const investigation = artifact?.contract?.investigation;
      if (
        !job ||
        !artifact ||
        artifact.digest !== plan.approvedDigest ||
        !investigation
      ) {
        throw new Error("The approved research contract is unavailable");
      }
      if (job.status !== "waiting_for_user") {
        throw new Error(
          "This research job is not waiting for an expansion decision",
        );
      }
      if (
        !shouldCheckpointResearchExpansion({
          approvedEstimate: investigation.estimatedDeepReadPapers,
          actualDeepReadCandidates: job.candidateItems,
          approvedLargeCorpus: investigation.approvedLargeCorpus,
          policy: job.policy,
        })
      ) {
        throw new Error(
          "The research expansion checkpoint is no longer required",
        );
      }
      if (
        input.proposedDeepReadCeiling < job.candidateItems ||
        input.proposedDeepReadCeiling <= job.deepReadPlanned
      ) {
        throw new Error(
          "The approved ceiling must cover current candidates and exceed the prior ceiling",
        );
      }
      const now = Date.now();
      const next = {
        ...job,
        status: "running" as const,
        deepReadPlanned: input.proposedDeepReadCeiling,
        updatedAt: now,
      };
      await saveResearchJob(next, artifact.conversationKey);
      await context.publishPlanEvent?.({
        type: "plan_research_progress",
        progress: progress(next),
      });
      return {
        approved: true,
        deepReadPlanned: next.deepReadPlanned,
        candidateItems: next.candidateItems,
      };
    },
  };
}
