import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { planExecutionCoordinator } from "../../plans/coordinator";
import type { PlanStepEffect } from "../../plans/types";
import { fail, ok, validateObject } from "../shared";

type UpdatePlanInput = {
  explanation?: string;
  ready: boolean;
  steps: Array<{
    planStepId?: string;
    content: string;
    activeForm: string;
    acceptanceCriteria: string[];
    expectedCapability?: string;
    expectedEffect: PlanStepEffect;
  }>;
};

const EFFECTS = new Set<PlanStepEffect>([
  "read",
  "artifact",
  "mutation",
  "reasoning",
]);

function validateUpdatePlanInput(
  args: unknown,
): AgentToolInputValidation<UpdatePlanInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("update_plan expects an object");
  }
  if (!Array.isArray(args.steps) || !args.steps.length) {
    return fail("update_plan requires at least one step");
  }
  const steps: UpdatePlanInput["steps"] = [];
  for (let index = 0; index < args.steps.length; index += 1) {
    const raw = args.steps[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      return fail(`steps[${index}] must be an object`);
    }
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const activeForm =
      typeof raw.activeForm === "string" ? raw.activeForm.trim() : "";
    const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
      : [];
    const expectedEffect = raw.expectedEffect as PlanStepEffect;
    if (!content || !activeForm || !acceptanceCriteria.length) {
      return fail(
        `steps[${index}] requires content, activeForm, and acceptanceCriteria`,
      );
    }
    if (!EFFECTS.has(expectedEffect)) {
      return fail(`steps[${index}].expectedEffect is invalid`);
    }
    steps.push({
      planStepId:
        typeof raw.planStepId === "string" && raw.planStepId.trim()
          ? raw.planStepId.trim()
          : undefined,
      content,
      activeForm,
      acceptanceCriteria,
      expectedCapability:
        typeof raw.expectedCapability === "string" &&
        raw.expectedCapability.trim()
          ? raw.expectedCapability.trim()
          : undefined,
      expectedEffect,
    });
  }
  return ok({
    explanation:
      typeof args.explanation === "string" && args.explanation.trim()
        ? args.explanation.trim()
        : undefined,
    ready: args.ready === true,
    steps,
  });
}

export function createUpdatePlanTool(): AgentToolDefinition<
  UpdatePlanInput,
  unknown
> {
  return {
    spec: {
      name: "update_plan",
      description:
        "Create or revise the structured plan. Approved steps are immutable; this tool is available only during planning. Set ready=true only when the plan is ready for user review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["steps", "ready"],
        properties: {
          explanation: { type: "string" },
          ready: { type: "boolean" },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "content",
                "activeForm",
                "acceptanceCriteria",
                "expectedEffect",
              ],
              properties: {
                planStepId: { type: "string" },
                content: {
                  type: "string",
                  description:
                    "Concise user-visible step, ideally one sentence under 140 characters.",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Short present-progress label shown while this step runs.",
                },
                acceptanceCriteria: {
                  type: "array",
                  minItems: 1,
                  description:
                    "Objective completion checks used by the host; keep implementation detail here rather than in content.",
                  items: { type: "string" },
                },
                expectedCapability: { type: "string" },
                expectedEffect: {
                  type: "string",
                  enum: ["read", "artifact", "mutation", "reasoning"],
                },
              },
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    isAvailable: (request) => request.planContext?.phase === "planning",
    guidance: {
      matches: (request) => request.planContext?.phase === "planning",
      instruction:
        "You are planning, not executing. Use read-only Zotero/PDF/web/literature tools as needed. Never call a write, command, script, import, upload, or settings tool. Call update_plan with 3–7 stable steps and objective acceptance criteria. Keep each user-visible content field to one short sentence and put validation detail in acceptanceCriteria. Set ready=true only after the plan is complete for review.",
    },
    validate: validateUpdatePlanInput,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "planning") {
        throw new Error("update_plan is available only during planning");
      }
      const artifact = await planExecutionCoordinator.updateDraft({
        planId: plan.planId,
        conversationKey: context.request.conversationKey,
        provider: plan.provider,
        revision: plan.revision,
        explanation: input.explanation,
        steps: input.steps,
        actionContractId: context.request.actionContract?.id,
        actionContract: context.request.actionContract,
        sourceRunId: context.runId,
        skillRoutingReceipt: context.request.skillRoutingReceipt
          ? {
              routerSchemaVersion:
                context.request.skillRoutingReceipt.routerSchemaVersion,
              skillManifestHash:
                context.request.skillRoutingReceipt.skillManifestHash,
              skills: context.request.skillRoutingReceipt.skills.map(
                ({ id, version, instructionHash, source }) => ({
                  id,
                  version,
                  instructionHash,
                  source,
                }),
              ),
            }
          : undefined,
        ready: input.ready,
      });
      await context.publishPlanEvent?.({
        type: input.ready ? "plan_ready" : "plan_updated",
        artifact,
      });
      return { artifact };
    },
  };
}
