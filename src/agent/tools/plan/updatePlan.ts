import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { planExecutionCoordinator } from "../../plans/coordinator";
import {
  buildDefaultPlanContract,
  decodePlanContract,
} from "../../plans/contracts";
import type {
  PlanCompletionRequirementKind,
  PlanContract,
  PlanStepEffect,
} from "../../plans/types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { resolvePlanDocumentCitationPreference } from "../../documents/citationPreference";
import { materializeResearchScopeSnapshot } from "../../research/scopeSnapshot";
import { fail, ok, validateObject } from "../shared";

type UpdatePlanInput = {
  explanation?: string;
  ready: boolean;
  contract?: unknown;
  steps: Array<{
    planStepId?: string;
    content: string;
    activeForm: string;
    acceptanceCriteria: string[];
    expectedCapability?: string;
    expectedEffect: PlanStepEffect;
    completionRequirements?: PlanCompletionRequirementKind[];
  }>;
};

const EFFECTS = new Set<PlanStepEffect>([
  "read",
  "artifact",
  "mutation",
  "reasoning",
]);

const COMPLETION_REQUIREMENTS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "bounded_reasoning",
  "research_coverage",
  "document_integrity",
  "document_published",
  "mutation_receipts",
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
    const completionRequirements = Array.isArray(raw.completionRequirements)
      ? raw.completionRequirements.filter(
          (entry): entry is PlanCompletionRequirementKind =>
            typeof entry === "string" &&
            COMPLETION_REQUIREMENTS.has(entry as PlanCompletionRequirementKind),
        )
      : undefined;
    if (
      Array.isArray(raw.completionRequirements) &&
      completionRequirements?.length !== raw.completionRequirements.length
    ) {
      return fail(`steps[${index}].completionRequirements is invalid`);
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
      completionRequirements,
    });
  }
  if (args.ready === true && (steps.length < 3 || steps.length > 7)) {
    return fail("A ready plan requires 3–7 user-visible steps");
  }
  return ok({
    explanation:
      typeof args.explanation === "string" && args.explanation.trim()
        ? args.explanation.trim()
        : undefined,
    ready: args.ready === true,
    contract: validateObject(args.contract) ? args.contract : undefined,
    steps,
  });
}

async function resolvePlanContract(params: {
  raw: unknown;
  steps: UpdatePlanInput["steps"];
  actionContract?: NonNullable<
    import("../../types").AgentRuntimeRequest["actionContract"]
  >;
  ready: boolean;
  gateway?: ZoteroGateway;
  planId: string;
  revision: number;
  conversationKey: number;
}): Promise<PlanContract> {
  const defaultContract = buildDefaultPlanContract({
    actionContract: params.actionContract,
    steps: params.steps,
  });
  const raw: Record<string, unknown> = validateObject<Record<string, unknown>>(
    params.raw,
  )
    ? { ...params.raw }
    : { ...defaultContract };
  const deliverable = validateObject<Record<string, unknown>>(raw.deliverable)
    ? { ...raw.deliverable }
    : defaultContract.deliverable;
  if (
    validateObject<Record<string, unknown>>(deliverable) &&
    deliverable.kind === "document"
  ) {
    const spec = validateObject<Record<string, unknown>>(deliverable.spec)
      ? { ...deliverable.spec }
      : {};
    if (!validateObject(spec.citationStyle)) {
      spec.citationStyle = resolvePlanDocumentCitationPreference(
        params.gateway,
      );
    }
    raw.deliverable = { ...deliverable, spec };
  }
  if (validateObject<Record<string, unknown>>(raw.effects)) {
    const effects = { ...raw.effects };
    if (validateObject<Record<string, unknown>>(effects.libraryMutation)) {
      const mutation = { ...effects.libraryMutation };
      if (mutation.approval === "initial" && !mutation.contract) {
        if (!params.actionContract) {
          throw new Error(
            "An initially approved library mutation requires a frozen action contract",
          );
        }
        mutation.contract = params.actionContract;
      }
      effects.libraryMutation = mutation;
      raw.effects = effects;
    }
  }
  let contract = decodePlanContract(raw, { requireSnapshot: false });
  if (contract.investigation && !contract.investigation.criteria.length) {
    throw new Error(
      "A research investigation requires at least one explicit inclusion or exclusion criterion",
    );
  }
  if (params.ready && contract.investigation) {
    if (!params.gateway) {
      throw new Error(
        "The Zotero gateway is required to freeze research scope",
      );
    }
    const snapshot = await materializeResearchScopeSnapshot({
      gateway: params.gateway,
      planId: params.planId,
      revision: params.revision,
      conversationKey: params.conversationKey,
      scope: contract.investigation.scope,
    });
    contract = decodePlanContract(
      {
        ...contract,
        investigation: {
          ...contract.investigation,
          scopeSnapshot: snapshot.ref,
        },
      },
      { requireSnapshot: true },
    );
  }
  return contract;
}

export function createUpdatePlanTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
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
          contract: {
            type: "object",
            description:
              "Composable approved outcome. Omit effects unless the user explicitly requested a Zotero library write. The host adds scopeSnapshot, researchPolicy, and the resolved citationStyle; do not invent them.",
            additionalProperties: false,
            required: ["deliverable"],
            properties: {
              investigation: {
                type: "object",
                additionalProperties: false,
                required: [
                  "question",
                  "subquestions",
                  "criteria",
                  "scope",
                  "requiredEvidenceDepth",
                  "estimatedDeepReadPapers",
                  "approvedLargeCorpus",
                ],
                properties: {
                  question: { type: "string" },
                  subquestions: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "question"],
                      properties: {
                        id: { type: "string" },
                        question: { type: "string" },
                      },
                    },
                  },
                  criteria: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "description", "kind"],
                      properties: {
                        id: { type: "string" },
                        description: { type: "string" },
                        kind: {
                          type: "string",
                          enum: ["include", "exclude"],
                        },
                      },
                    },
                  },
                  scope: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "kind"],
                    properties: {
                      libraryID: { type: "integer", minimum: 1 },
                      kind: {
                        type: "string",
                        enum: [
                          "library",
                          "collections",
                          "tags",
                          "items",
                          "mixed",
                        ],
                      },
                      collectionIds: {
                        type: "array",
                        items: { type: "integer", minimum: 1 },
                      },
                      tagNames: {
                        type: "array",
                        items: { type: "string" },
                      },
                      includeAutomaticTags: { type: "boolean" },
                      itemKeys: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                  queryVariants: {
                    type: "array",
                    items: { type: "string" },
                  },
                  requiredEvidenceDepth: {
                    type: "string",
                    enum: ["metadata", "abstract", "body"],
                  },
                  estimatedDeepReadPapers: {
                    type: "integer",
                    minimum: 0,
                  },
                  approvedLargeCorpus: { type: "boolean" },
                },
              },
              deliverable: {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["answer", "document", "completion_report"],
                  },
                  spec: {
                    type: "object",
                    description:
                      "Required only when deliverable.kind is document.",
                    additionalProperties: false,
                    required: [
                      "kind",
                      "title",
                      "requiredSections",
                      "requiresReferences",
                      "requiresCoverageSection",
                      "allowFigures",
                    ],
                    properties: {
                      kind: {
                        type: "string",
                        enum: [
                          "research_brief",
                          "literature_review",
                          "comparison",
                          "report",
                          "guide",
                          "custom",
                        ],
                      },
                      title: { type: "string" },
                      requiredSections: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string" },
                      },
                      requiresReferences: { type: "boolean" },
                      requiresCoverageSection: { type: "boolean" },
                      allowFigures: { type: "boolean" },
                    },
                  },
                },
              },
              effects: {
                type: "object",
                description:
                  "Include only for a library write explicitly requested by the user.",
                additionalProperties: false,
                required: ["libraryMutation"],
                properties: {
                  libraryMutation: {
                    type: "object",
                    additionalProperties: false,
                    required: ["approval"],
                    properties: {
                      approval: {
                        type: "string",
                        enum: ["initial", "after_research"],
                      },
                      intent: {
                        type: "object",
                        description:
                          "Required for after_research. Exact targets are determined later and require a second approval.",
                        additionalProperties: false,
                        required: [
                          "summary",
                          "intents",
                          "targetSelectionDescription",
                        ],
                        properties: {
                          summary: { type: "string" },
                          targetSelectionDescription: { type: "string" },
                          intents: {
                            type: "array",
                            minItems: 1,
                            items: {
                              type: "object",
                              additionalProperties: true,
                              required: [
                                "capability",
                                "operation",
                                "proofDomain",
                                "coverage",
                                "targetKind",
                              ],
                              properties: {
                                capability: { type: "string" },
                                operation: { type: "string" },
                                proofDomain: {
                                  type: "string",
                                  enum: [
                                    "zotero_state",
                                    "file_state",
                                    "execution",
                                  ],
                                },
                                coverage: {
                                  type: "string",
                                  enum: ["one", "some", "all"],
                                },
                                targetKind: {
                                  type: "string",
                                  enum: ["papers", "items"],
                                },
                                parameters: {
                                  type: "object",
                                  additionalProperties: true,
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 7,
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
                completionRequirements: {
                  type: "array",
                  uniqueItems: true,
                  items: {
                    type: "string",
                    enum: [
                      "verified_read",
                      "bounded_reasoning",
                      "research_coverage",
                      "document_integrity",
                      "document_published",
                      "mutation_receipts",
                    ],
                  },
                },
              },
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "planning",
    guidance: {
      matches: (request) => request.planContext?.phase === "planning",
      instruction:
        "You are planning, not executing. Use read-only Zotero/PDF/web/literature tools as needed. Never call a write, command, script, import, upload, or settings tool. Call update_plan with a composable contract and 3–7 stable steps. For a fuzzy multi-paper document, use contract.investigation with question, stable subquestion/criterion IDs, scope such as {libraryID:1,kind:'library'}, requiredEvidenceDepth, estimatedDeepReadPapers, and approvedLargeCorpus; use deliverable:{kind:'document',spec:{kind:'literature_review',title,requiredSections,requiresReferences:true,requiresCoverageSection:true,allowFigures:false}}. Omit effects entirely unless the user explicitly requested a library write. A research-selected write must use effects.libraryMutation.approval='after_research' with summary, targetSelectionDescription, and action intents; never claim the initial plan authorizes unknown targets. Use research_coverage on the screening/deep-evidence task, document_integrity and document_published on the document task, and mutation_receipts only on a mutation task. Put objective validation in acceptanceCriteria. Set ready=true only after the plan is complete for review; the host freezes the exact Zotero corpus, research policy, and citation preferences.",
    },
    validate: validateUpdatePlanInput,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "planning") {
        throw new Error("update_plan is available only during planning");
      }
      const contract = await resolvePlanContract({
        raw: input.contract,
        steps: input.steps.map(({ completionRequirements, ...step }) => ({
          ...step,
          completionRequirementKinds: completionRequirements,
        })),
        actionContract: context.request.actionContract,
        ready: input.ready,
        gateway,
        planId: plan.planId,
        revision: plan.revision,
        conversationKey: context.request.conversationKey,
      });
      const artifact = await planExecutionCoordinator.updateDraft({
        planId: plan.planId,
        conversationKey: context.request.conversationKey,
        provider: plan.provider,
        revision: plan.revision,
        explanation: input.explanation,
        steps: input.steps,
        contract,
        actionContractId: context.request.actionContract?.id,
        actionContract: context.request.actionContract,
        sourceRunId: context.runId || "external-mcp-structured",
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
