import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { canonicalJson } from "../../services/libraryMutation/canonicalJson";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { planExecutionCoordinator } from "../../plans/coordinator";
import {
  listTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../../plans/store";
import {
  shouldCheckpointResearchExpansion,
  type ResearchStage,
} from "../../research/policy";
import { getResearchItemFingerprints } from "../../research/scopeSnapshot";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEvidence,
  listResearchRecallProbes,
  listScopeSnapshotItems,
  listThemeFindings,
  loadResearchJobForExecution,
  loadResearchWorkItem,
  savePaperFinding,
  saveResearchCorpusItem,
  saveResearchEvidence,
  saveResearchJob,
  saveResearchRecallProbe,
  saveResearchWorkItem,
  saveThemeFinding,
} from "../../research/store";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEvidenceRecord,
  ResearchJob,
  ResearchProgress,
  ResearchRecallProbe,
  ThemeFinding,
} from "../../research/types";
import type { TaskEvidence, VerifiedReadSource } from "../../plans/types";
import { fail, ok, validateObject } from "../shared";

type ResearchUpdateInput = {
  operation:
    | "inventory_scope"
    | "list_verified_reads"
    | "list_findings"
    | "record_papers"
    | "record_probes"
    | "record_themes"
    | "set_stage"
    | "finalize";
  stage?: ResearchStage;
  cursor?: number;
  limit?: number;
  papers?: unknown[];
  probes?: unknown[];
  themes?: unknown[];
  outcome?: "complete" | "partial" | "failed";
};

const STAGES: ResearchStage[] = [
  "inventory",
  "broad_screening",
  "recall_expansion",
  "deep_evidence",
  "paper_findings",
  "hierarchical_synthesis",
];

const SCREENING_STATUSES = new Set<ResearchCorpusItem["screeningStatus"]>([
  "pending",
  "candidate",
  "included",
  "excluded",
  "unresolved",
  "unreadable",
  "missing",
]);
const MAX_PAPERS_PER_UPDATE = 25;

type PreferredVerifiedRead = Readonly<{
  sourceReadRef: string;
  sources: readonly VerifiedReadSource[];
  evidenceDepth: "metadata" | "body";
}>;

function verifiedReadDepth(sources: readonly VerifiedReadSource[]) {
  return sources.some(
    (source) =>
      Boolean(source.attachmentItemKey) ||
      source.pageIndex !== undefined ||
      Boolean(source.sourceFingerprint),
  )
    ? "body"
    : "metadata";
}

/**
 * Choose one compact receipt per paper without letting a later metadata-only
 * bulk read hide an earlier PDF/body read. The full receipt set remains the
 * validation authority; this is only the model-facing recovery projection.
 */
export function selectPreferredVerifiedReads(
  evidence: readonly TaskEvidence[],
  corpusIdentities: ReadonlySet<string>,
): Map<string, PreferredVerifiedRead> {
  const selected = new Map<
    string,
    PreferredVerifiedRead & Readonly<{ createdAt: number }>
  >();
  for (const entry of evidence) {
    if (
      entry.kind !== "verified_read" ||
      !entry.verified ||
      !entry.reference ||
      entry.payload?.type !== "verified_read"
    ) {
      continue;
    }
    const sources = entry.payload.sources || [];
    for (const source of sources) {
      const identity = `${source.libraryID}:${source.itemKey}`;
      if (!corpusIdentities.has(identity)) continue;
      const matchingSources = sources.filter(
        (candidate) =>
          candidate.libraryID === source.libraryID &&
          candidate.itemKey === source.itemKey,
      );
      const candidate = {
        sourceReadRef: entry.reference,
        sources: matchingSources,
        evidenceDepth: verifiedReadDepth(matchingSources),
        createdAt: entry.createdAt,
      } as const;
      const current = selected.get(identity);
      if (
        !current ||
        (current.evidenceDepth === "metadata" &&
          candidate.evidenceDepth === "body") ||
        (current.evidenceDepth === candidate.evidenceDepth &&
          candidate.createdAt >= current.createdAt)
      ) {
        selected.set(identity, candidate);
      }
    }
  }
  return new Map(
    [...selected.entries()].map(([identity, entry]) => [
      identity,
      {
        sourceReadRef: entry.sourceReadRef,
        sources: entry.sources,
        evidenceDepth: entry.evidenceDepth,
      },
    ]),
  );
}

function validateResearchUpdate(
  args: unknown,
): AgentToolInputValidation<ResearchUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("research_update expects an object");
  }
  const operation = args.operation as ResearchUpdateInput["operation"];
  if (
    ![
      "inventory_scope",
      "list_verified_reads",
      "list_findings",
      "record_papers",
      "record_probes",
      "record_themes",
      "set_stage",
      "finalize",
    ].includes(String(operation))
  ) {
    return fail("research_update operation is invalid");
  }
  if (
    args.stage !== undefined &&
    !STAGES.includes(args.stage as ResearchStage)
  ) {
    return fail("research_update stage is invalid");
  }
  if (
    args.cursor !== undefined &&
    (!Number.isInteger(args.cursor) || Number(args.cursor) < 0)
  ) {
    return fail("research_update cursor must be a non-negative integer");
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      Number(args.limit) < 1 ||
      Number(args.limit) > 25)
  ) {
    return fail("research_update limit must be an integer from 1 to 25");
  }
  if (operation === "record_papers" && !Array.isArray(args.papers)) {
    return fail("record_papers requires papers[]");
  }
  if (
    operation === "record_papers" &&
    Array.isArray(args.papers) &&
    (args.papers.length < 1 || args.papers.length > MAX_PAPERS_PER_UPDATE)
  ) {
    return fail(
      `record_papers accepts 1–${MAX_PAPERS_PER_UPDATE} papers per call`,
    );
  }
  if (operation === "record_probes" && !Array.isArray(args.probes)) {
    return fail("record_probes requires probes[]");
  }
  if (operation === "record_themes" && !Array.isArray(args.themes)) {
    return fail("record_themes requires themes[]");
  }
  if (
    operation === "finalize" &&
    !["complete", "partial", "failed"].includes(String(args.outcome))
  ) {
    return fail("finalize requires outcome complete, partial, or failed");
  }
  return ok({
    operation,
    stage: args.stage as ResearchStage | undefined,
    cursor: args.cursor === undefined ? undefined : Number(args.cursor),
    limit: args.limit === undefined ? undefined : Number(args.limit),
    papers: Array.isArray(args.papers) ? args.papers : undefined,
    probes: Array.isArray(args.probes) ? args.probes : undefined,
    themes: Array.isArray(args.themes) ? args.themes : undefined,
    outcome: args.outcome as ResearchUpdateInput["outcome"],
  });
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function positiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function progress(job: ResearchJob): ResearchProgress {
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

async function recomputeJob(params: {
  job: ResearchJob;
  conversationKey: number;
  activeStage?: ResearchStage;
  status?: ResearchJob["status"];
  coverageStatus?: ResearchJob["coverageStatus"];
}): Promise<ResearchJob> {
  const corpus = await listResearchCorpusItems({
    researchJobId: params.job.researchJobId,
  });
  const evidence = await listResearchEvidence(params.job.researchJobId);
  const bodyKeys = new Set(
    evidence
      .filter((entry) => ["body", "figure", "quote"].includes(entry.sourceKind))
      .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
  );
  const candidateItems = corpus.filter((entry) =>
    ["candidate", "included", "unresolved", "unreadable"].includes(
      entry.screeningStatus,
    ),
  ).length;
  const now = Date.now();
  const next: ResearchJob = {
    ...params.job,
    status: params.status || "running",
    activeStage: params.activeStage || params.job.activeStage,
    coverageStatus: params.coverageStatus,
    screenedItems: corpus.filter((entry) => entry.screeningStatus !== "pending")
      .length,
    candidateItems,
    deepReadCompleted: bodyKeys.size,
    deepReadPlanned: params.job.deepReadPlanned,
    updatedAt: now,
    completedAt:
      params.status === "completed" || params.status === "failed"
        ? now
        : undefined,
  };
  await saveResearchJob(next, params.conversationKey);
  return next;
}

function parseCriterionResults(
  value: unknown,
  allowed: Set<string>,
  label: string,
): Record<string, "met" | "not_met" | "unknown"> {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const out: Record<string, "met" | "not_met" | "unknown"> = {};
  for (const [criterionId, result] of Object.entries(value)) {
    if (!allowed.has(criterionId)) {
      throw new Error(`${label} references unknown criterion ${criterionId}`);
    }
    if (!new Set(["met", "not_met", "unknown"]).has(String(result))) {
      throw new Error(`${label}.${criterionId} is invalid`);
    }
    out[criterionId] = result as "met" | "not_met" | "unknown";
  }
  return out;
}

export function createResearchUpdateTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<ResearchUpdateInput, unknown> {
  return {
    spec: {
      name: "research_update",
      description:
        "Persist normalized per-paper research decisions, evidence provenance, findings, theme reductions, progress, and terminal coverage for the approved frozen corpus. This does not mutate the Zotero library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: [
              "record_papers",
              "inventory_scope",
              "list_verified_reads",
              "list_findings",
              "record_probes",
              "record_themes",
              "set_stage",
              "finalize",
            ],
          },
          stage: { type: "string", enum: STAGES },
          cursor: {
            type: "integer",
            minimum: 0,
            description:
              "Zero-based cursor returned by list_findings. Omit for the first page.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "Page size for list_findings; defaults to 20.",
          },
          papers: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PAPERS_PER_UPDATE,
            description:
              "One to 25 frozen-corpus paper updates per transactional call. Batch broad-screening decisions so a corpus does not consume one model turn per paper; an invalid indexed entry rejects the whole batch for correction. Do not use this to inventory the scope; call inventory_scope once. screeningStatus and criterionResults are required for every paper. Call list_verified_reads first; non-metadata evidence must use one of its exact sourceReadRef values and may use only its trusted locator fields.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "libraryID",
                "itemKey",
                "screeningStatus",
                "criterionResults",
              ],
              properties: {
                libraryID: { type: "integer", minimum: 1 },
                itemKey: { type: "string" },
                screeningStatus: {
                  type: "string",
                  enum: [
                    "pending",
                    "candidate",
                    "included",
                    "excluded",
                    "unresolved",
                    "unreadable",
                    "missing",
                  ],
                },
                criterionResults: {
                  type: "object",
                  description:
                    "Map every approved criterion ID to met, not_met, or unknown during broad screening and later stages.",
                  additionalProperties: {
                    type: "string",
                    enum: ["met", "not_met", "unknown"],
                  },
                },
                decisionReason: { type: "string" },
                hasAbstract: { type: "boolean" },
                attachmentItemKeys: {
                  type: "array",
                  items: { type: "string" },
                },
                duplicateAttachmentKeys: {
                  type: "array",
                  items: { type: "string" },
                },
                readable: { type: "boolean" },
                indexed: { type: "boolean" },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["evidenceKey", "sourceKind"],
                    properties: {
                      evidenceKey: { type: "string" },
                      sourceKind: {
                        type: "string",
                        enum: [
                          "metadata",
                          "abstract",
                          "body",
                          "figure",
                          "quote",
                        ],
                      },
                      sourceReadRef: {
                        type: "string",
                        description:
                          "Exact sourceReadRef returned by list_verified_reads for this paper. Required for abstract, body, figure, and quote evidence.",
                      },
                      locator: {
                        type: "object",
                        additionalProperties: false,
                        required: ["attachmentItemKey", "pageIndex"],
                        properties: {
                          attachmentItemKey: { type: "string" },
                          pageIndex: { type: "integer", minimum: 0 },
                        },
                      },
                    },
                  },
                },
                finding: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "subquestionIds",
                    "criterionIds",
                    "findings",
                    "contradictions",
                    "negativeEvidence",
                    "limitations",
                    "evidenceKeys",
                    "inclusionDecision",
                    "confidence",
                    "unresolvedQuestions",
                  ],
                  properties: {
                    subquestionIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    criterionIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                    findings: {
                      type: "array",
                      items: { type: "string" },
                    },
                    contradictions: {
                      type: "array",
                      items: { type: "string" },
                    },
                    negativeEvidence: {
                      type: "array",
                      items: { type: "string" },
                    },
                    limitations: {
                      type: "array",
                      items: { type: "string" },
                    },
                    evidenceKeys: {
                      type: "array",
                      items: { type: "string" },
                    },
                    inclusionDecision: {
                      type: "string",
                      enum: ["include", "exclude", "unresolved"],
                    },
                    confidence: {
                      type: "string",
                      enum: ["low", "medium", "high"],
                    },
                    unresolvedQuestions: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          probes: {
            type: "array",
            description:
              "Durable recall-expansion probes. addedTargets contains only frozen-corpus candidates newly added by this probe; use [] when the probe confirmed existing candidates but added none.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["probeId", "kind", "query", "addedTargets"],
              properties: {
                probeId: { type: "string" },
                kind: {
                  type: "string",
                  enum: [
                    "synonym",
                    "abbreviation",
                    "translation",
                    "semantic",
                    "reformulation",
                  ],
                },
                query: { type: "string" },
                addedTargets: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "itemKey"],
                    properties: {
                      libraryID: { type: "integer", minimum: 1 },
                      itemKey: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          themes: {
            type: "array",
            description:
              "Theme reductions with themeId, title, synthesis, paperFindingIds, evidenceRefs, and limitations.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "themeId",
                "title",
                "synthesis",
                "paperFindingIds",
                "evidenceRefs",
                "limitations",
              ],
              properties: {
                themeId: { type: "string" },
                title: { type: "string" },
                synthesis: { type: "string" },
                paperFindingIds: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
                evidenceRefs: {
                  type: "array",
                  items: { type: "string" },
                },
                limitations: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
          outcome: {
            type: "string",
            enum: ["complete", "partial", "failed"],
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "For an approved investigation, use research_update to persist work rather than keeping a paper list only in model context. First call {operation:'inventory_scope'} exactly once; the host inventories every frozen item, attachment key, duplicate, readability, abstract, and index state without making you enumerate the corpus. Then advance stages in order with set_stage. During broad screening, batch up to 25 papers in each record_papers call, with every approved criterion ID mapped to met, not_met, or unknown for every paper. An invalid papers[index] rejects the transactional batch; correct that indexed entry and retry the batch. Persist recall-expansion probes with record_probes, deep-read included or unresolved candidates, then call {operation:'list_verified_reads'} to obtain the exact approved criterion/subquestion IDs, per-paper durable status, strongest durable sourceReadRef, exact findingId, and exact evidenceRefs. A verifiedReads entry with evidenceDepth:'body' is a PDF/body-capable receipt and is preferred across resumed runs; use its exact trusted locator fields. On resume at synthesis or drafting, page through {operation:'list_findings'} until nextCursor is null; use those durable normalized findings instead of recovering old tool handles or rereading PDFs. For record_themes and submit_plan_document, copy findingId and evidenceRefs exactly; never shorten or invent their IDs. Never invent criterion IDs or omit an approved criterion. Detailed evidence and findings may also be persisted in validated batches of up to 25 papers. Store one paper finding per paper and durable theme reductions. Missing evidence is unresolved, never negative evidence. Finalize only after the approved coverage is terminal; the host derives complete versus complete_with_limitations and emits aggregate progress.",
    },
    validate: validateResearchUpdate,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error("research_update requires approved plan execution");
      }
      const job = await loadResearchJobForExecution(plan.executionId);
      if (!job) throw new Error("This plan has no research job");
      if (
        job.status === "waiting_for_user" &&
        !(
          input.operation === "finalize" &&
          (input.outcome === "partial" || input.outcome === "failed")
        )
      ) {
        throw new Error(
          "Research is waiting for the expansion checkpoint; obtain approval, revise the plan, or finalize a partial result",
        );
      }
      const executionLedger = await loadPlanExecutionLedger(plan.executionId);
      const activeTask = executionLedger?.tasks.find(
        (entry) => entry.taskId === plan.activeTaskId,
      );
      if (!activeTask || activeTask.expectedEffect === "mutation") {
        throw new Error(
          "Research updates require an active non-mutation plan task",
        );
      }
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      const investigation = artifact?.contract?.investigation;
      if (!artifact || !investigation || !artifact.contractDigest) {
        throw new Error("The approved research contract is unavailable");
      }
      if (job.contractDigest !== artifact.contractDigest) {
        throw new Error(
          "Research job contract digest no longer matches the plan",
        );
      }
      const corpus = await listResearchCorpusItems({
        researchJobId: job.researchJobId,
      });
      const corpusByKey = new Map(
        corpus.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
      );
      const snapshot = await listScopeSnapshotItems(job.snapshotId);
      const snapshotByKey = new Map(
        snapshot.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
      );
      const taskEvidence = (
        await Promise.all(
          (executionLedger?.tasks || []).map((entry) =>
            listTaskEvidence(plan.executionId, entry.taskId),
          ),
        )
      ).flat();
      const verifiedReads = new Map(
        taskEvidence
          .filter(
            (entry) =>
              entry.kind === "verified_read" &&
              entry.verified &&
              entry.reference,
          )
          .map((entry) => [
            entry.reference!,
            entry.payload?.type === "verified_read"
              ? entry.payload.sources || []
              : [],
          ]),
      );
      if (input.operation === "list_verified_reads") {
        const preferredByPaper = selectPreferredVerifiedReads(
          taskEvidence,
          new Set(corpusByKey.keys()),
        );
        const [recordedFindings, durableEvidence] = await Promise.all([
          listPaperFindings(job.researchJobId),
          listResearchEvidence(job.researchJobId),
        ]);
        const findingByPaper = new Map(
          recordedFindings.map((entry) => [
            `${entry.libraryID}:${entry.itemKey}`,
            entry,
          ]),
        );
        const bodyEvidenceKeys = new Set(
          durableEvidence
            .filter((entry) =>
              ["body", "figure", "quote"].includes(entry.sourceKind),
            )
            .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        );
        return {
          researchContract: {
            criteria: investigation.criteria,
            subquestions: investigation.subquestions,
            requiredEvidenceDepth: investigation.requiredEvidenceDepth,
          },
          papers: corpus.map((entry) => {
            const identity = `${entry.libraryID}:${entry.itemKey}`;
            const finding = findingByPaper.get(identity);
            return {
              identity,
              screeningStatus: entry.screeningStatus,
              criterionResults: entry.criterionResults,
              findingRecorded: Boolean(finding),
              findingId: finding?.findingId,
              evidenceRefs: finding?.evidenceRefs || [],
              bodyEvidenceRecorded: bodyEvidenceKeys.has(identity),
            };
          }),
          findingRecovery: {
            operation: "list_findings",
            totalFindings: recordedFindings.length,
            pageSize: 20,
            instruction:
              "Page durable normalized findings before synthesis; do not recover old tool handles or reread PDFs.",
          },
          verifiedReads: [...preferredByPaper.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([identity, entry]) => ({ identity, ...entry })),
        };
      }
      if (input.operation === "list_findings") {
        const findings = await listPaperFindings(job.researchJobId);
        const corpusOrdinal = new Map(
          corpus.map((entry) => [
            `${entry.libraryID}:${entry.itemKey}`,
            entry.ordinal,
          ]),
        );
        findings.sort(
          (left, right) =>
            (corpusOrdinal.get(`${left.libraryID}:${left.itemKey}`) ??
              Number.MAX_SAFE_INTEGER) -
            (corpusOrdinal.get(`${right.libraryID}:${right.itemKey}`) ??
              Number.MAX_SAFE_INTEGER),
        );
        const cursor = input.cursor || 0;
        const limit = input.limit || 20;
        const page = findings.slice(cursor, cursor + limit).map((finding) => ({
          findingId: finding.findingId,
          identity: `${finding.libraryID}:${finding.itemKey}`,
          subquestionIds: finding.subquestionIds,
          criterionIds: finding.criterionIds,
          findings: finding.findings,
          contradictions: finding.contradictions,
          negativeEvidence: finding.negativeEvidence,
          limitations: finding.limitations,
          evidenceRefs: finding.evidenceRefs,
          inclusionDecision: finding.inclusionDecision,
          confidence: finding.confidence,
          unresolvedQuestions: finding.unresolvedQuestions,
        }));
        const nextCursor = cursor + page.length;
        return {
          findings: page,
          nextCursor: nextCursor < findings.length ? nextCursor : null,
          totalFindings: findings.length,
        };
      }
      const allowedCriteria = new Set(
        investigation.criteria.map((entry) => entry.id),
      );
      const allowedSubquestions = new Set(
        investigation.subquestions.map((entry) => entry.id),
      );
      const existingEvidence = await listResearchEvidence(job.researchJobId);
      const evidenceByRef = new Map(
        existingEvidence.map((entry) => [entry.evidenceRef, entry]),
      );
      const newEvidenceRefs: Record<string, string> = {};
      const completeWorkItem = async (params: {
        libraryID: number;
        itemKey: string;
        stage: ResearchStage;
        evidenceRefs?: readonly string[];
        subquestionIds?: readonly string[];
      }) => {
        const workItemId = `${job.researchJobId}:work:${params.stage}:${params.libraryID}:${params.itemKey}`;
        const existing = await loadResearchWorkItem(workItemId);
        const now = Date.now();
        await saveResearchWorkItem({
          version: 1,
          workItemId,
          researchJobId: job.researchJobId,
          executionId: job.executionId,
          parentTaskId: job.parentTaskId,
          libraryID: params.libraryID,
          itemKey: params.itemKey,
          stage: params.stage,
          subquestionIds: [...(params.subquestionIds || [])],
          status: "completed",
          attemptCount: Math.max(1, existing?.attemptCount || 0),
          evidenceRefs: [...new Set(params.evidenceRefs || [])],
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        });
      };

      if (input.operation === "set_stage" && input.stage) {
        const currentIndex = STAGES.indexOf(job.activeStage);
        const nextIndex = STAGES.indexOf(input.stage);
        if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
          throw new Error("Research stages must advance in order");
        }
      }
      const effectiveStage = input.stage || job.activeStage;
      if (
        input.operation === "inventory_scope" &&
        effectiveStage !== "inventory"
      ) {
        throw new Error(
          "The frozen scope can be inventoried only in inventory",
        );
      }
      if (
        input.operation === "record_papers" &&
        effectiveStage === "inventory"
      ) {
        throw new Error(
          "Use inventory_scope to inventory the frozen corpus, then advance to broad_screening",
        );
      }
      if (
        input.operation === "set_stage" &&
        job.activeStage === "inventory" &&
        input.stage === "broad_screening" &&
        corpus.some((entry) => !entry.inventoryRecorded)
      ) {
        throw new Error(
          "Inventory is incomplete; call inventory_scope before broad screening",
        );
      }
      if (
        input.operation === "record_probes" &&
        effectiveStage !== "recall_expansion"
      ) {
        throw new Error(
          "Recall probes may only be recorded during recall expansion",
        );
      }
      if (
        input.operation === "record_themes" &&
        effectiveStage !== "hierarchical_synthesis"
      ) {
        throw new Error(
          "Theme findings may only be recorded during hierarchical synthesis",
        );
      }
      if (
        input.operation === "finalize" &&
        input.outcome === "complete" &&
        job.activeStage !== "hierarchical_synthesis"
      ) {
        throw new Error("Research can finalize only after all six stages");
      }

      let inventoriedItems: number | undefined;
      if (input.operation === "inventory_scope") {
        let recorded = 0;
        for (const current of corpus) {
          const identity = `${current.libraryID}:${current.itemKey}`;
          const approvedSource = snapshotByKey.get(identity);
          if (!approvedSource) {
            throw new Error(`Paper ${identity} is outside the frozen corpus`);
          }
          const liveItem = Zotero.Items.getByLibraryAndKey(
            current.libraryID,
            current.itemKey,
          );
          if (!liveItem || liveItem.deleted) {
            await saveResearchCorpusItem({
              ...current,
              screeningStatus: "missing",
              inventoryRecorded: true,
              hasAbstract: false,
              attachmentItemKeys: [],
              duplicateAttachmentKeys: [],
              readable: false,
              indexed: false,
              decisionReason:
                "Item is missing from the approved library snapshot",
              updatedAt: Date.now(),
            });
            await completeWorkItem({
              libraryID: current.libraryID,
              itemKey: current.itemKey,
              stage: "inventory",
            });
            recorded += 1;
            continue;
          }
          const attachmentInfos = await gateway.getAllChildAttachmentInfos(
            liveItem.id,
          );
          const attachmentItems = attachmentInfos
            .map((attachment) => gateway.getItem(attachment.contextItemId))
            .filter((attachment): attachment is Zotero.Item =>
              Boolean(attachment),
            );
          const attachmentItemKeys = attachmentItems
            .map((attachment) => String(attachment.key || "").trim())
            .filter(Boolean);
          const seenHashes = new Set<string>();
          const duplicateAttachmentKeys: string[] = [];
          for (const attachment of attachmentItems) {
            const attachmentWithHash = attachment as Zotero.Item & {
              attachmentHash?: string;
              attachmentSyncedHash?: string;
            };
            const hash = String(
              attachmentWithHash.attachmentHash ||
                attachmentWithHash.attachmentSyncedHash ||
                "",
            ).trim();
            if (!hash) continue;
            if (seenHashes.has(hash)) {
              const key = String(attachment.key || "").trim();
              if (key) duplicateAttachmentKeys.push(key);
            } else {
              seenHashes.add(hash);
            }
          }
          let hasLocalReadableAttachment = false;
          for (const attachment of attachmentItems) {
            try {
              const path = await (
                attachment as Zotero.Item & {
                  getFilePathAsync?: () => Promise<string | false>;
                }
              ).getFilePathAsync?.();
              if (
                path &&
                (await (
                  globalThis as unknown as {
                    IOUtils?: { exists?: (path: string) => Promise<boolean> };
                  }
                ).IOUtils?.exists?.(path))
              ) {
                hasLocalReadableAttachment = true;
                break;
              }
            } catch {
              // Remote or missing attachments remain represented by their
              // Zotero index/cache state below.
            }
          }
          const indexed = attachmentInfos.some((attachment) =>
            ["indexed", "partial"].includes(
              String(attachment.indexingState || ""),
            ),
          );
          const readable =
            hasLocalReadableAttachment ||
            indexed ||
            attachmentInfos.some((attachment) =>
              Boolean(attachment.mineruCacheDir),
            );
          const liveFingerprints = await getResearchItemFingerprints(
            gateway,
            liveItem.id,
          );
          await saveResearchCorpusItem({
            ...current,
            screeningStatus: "pending",
            inventoryRecorded: true,
            hasAbstract: Boolean(
              String(liveItem.getField?.("abstractNote") || "").trim(),
            ),
            attachmentItemKeys: [...new Set(attachmentItemKeys)],
            duplicateAttachmentKeys: [...new Set(duplicateAttachmentKeys)],
            readable,
            indexed,
            sourceFingerprint:
              liveFingerprints.attachmentFingerprint ||
              liveFingerprints.metadataFingerprint,
            updatedAt: Date.now(),
          });
          await completeWorkItem({
            libraryID: current.libraryID,
            itemKey: current.itemKey,
            stage: "inventory",
          });
          recorded += 1;
        }
        inventoriedItems = recorded;
      }

      if (input.operation === "record_papers") {
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 0; index < (input.papers || []).length; index += 1) {
            const raw = input.papers![index];
            if (!validateObject<Record<string, unknown>>(raw)) {
              throw new Error(`papers[${index}] must be an object`);
            }
            const libraryID = positiveInt(
              raw.libraryID,
              `papers[${index}].libraryID`,
            );
            const itemKey = string(raw.itemKey, `papers[${index}].itemKey`);
            const identity = `${libraryID}:${itemKey}`;
            const current = corpusByKey.get(identity);
            const approvedSource = snapshotByKey.get(identity);
            if (!current || !approvedSource) {
              throw new Error(`Paper ${identity} is outside the frozen corpus`);
            }
            const liveItem = Zotero.Items.getByLibraryAndKey(
              libraryID,
              itemKey,
            );
            if (!liveItem || liveItem.deleted) {
              await saveResearchCorpusItem({
                ...current,
                screeningStatus: "missing",
                inventoryRecorded: true,
                hasAbstract: false,
                attachmentItemKeys: [],
                duplicateAttachmentKeys: [],
                readable: false,
                indexed: false,
                decisionReason:
                  "Item is missing from the approved library snapshot",
                updatedAt: Date.now(),
              });
              await completeWorkItem({
                libraryID,
                itemKey,
                stage: input.stage || job.activeStage,
              });
              continue;
            }
            const liveFingerprints = await getResearchItemFingerprints(
              gateway,
              liveItem.id,
            );
            const recordStage = input.stage || job.activeStage;
            if (recordStage === "inventory") {
              if (
                typeof raw.hasAbstract !== "boolean" ||
                typeof raw.readable !== "boolean" ||
                typeof raw.indexed !== "boolean" ||
                !Array.isArray(raw.attachmentItemKeys) ||
                !Array.isArray(raw.duplicateAttachmentKeys)
              ) {
                throw new Error(
                  `papers[${index}] inventory requires hasAbstract, readable, indexed, attachmentItemKeys, and duplicateAttachmentKeys`,
                );
              }
            }
            const status =
              raw.screeningStatus as ResearchCorpusItem["screeningStatus"];
            if (!SCREENING_STATUSES.has(status)) {
              throw new Error(`papers[${index}].screeningStatus is invalid`);
            }
            const parsedCriterionResults = parseCriterionResults(
              raw.criterionResults || {},
              allowedCriteria,
              `papers[${index}].criterionResults`,
            );
            const missingCriteria = [...allowedCriteria].filter(
              (criterionId) => !parsedCriterionResults[criterionId],
            );
            if (missingCriteria.length) {
              throw new Error(
                `papers[${index}].criterionResults must include every approved criterion: ${[
                  ...allowedCriteria,
                ].join(", ")}`,
              );
            }
            const evidenceKeyMap = new Map<string, string>();
            const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
            for (
              let evidenceIndex = 0;
              evidenceIndex < rawEvidence.length;
              evidenceIndex += 1
            ) {
              const entry = rawEvidence[evidenceIndex];
              if (!validateObject<Record<string, unknown>>(entry)) {
                throw new Error(
                  `papers[${index}].evidence[${evidenceIndex}] must be an object`,
                );
              }
              const evidenceKey = string(entry.evidenceKey, "evidenceKey");
              const sourceKind =
                entry.sourceKind as ResearchEvidenceRecord["sourceKind"];
              if (
                !new Set([
                  "metadata",
                  "abstract",
                  "body",
                  "figure",
                  "quote",
                ]).has(sourceKind)
              ) {
                throw new Error(
                  `Evidence ${evidenceKey} has an invalid sourceKind`,
                );
              }
              const sourceReadRef =
                typeof entry.sourceReadRef === "string"
                  ? entry.sourceReadRef.trim()
                  : "";
              const readSources = verifiedReads.get(sourceReadRef) || [];
              const matchingReadSources = readSources.filter(
                (source) =>
                  source.libraryID === libraryID && source.itemKey === itemKey,
              );
              if (sourceKind !== "metadata" && !matchingReadSources.length) {
                throw new Error(
                  `Evidence ${evidenceKey} is not bound to a verified read of ${identity}`,
                );
              }
              const fingerprint = ["body", "figure", "quote"].includes(
                sourceKind,
              )
                ? approvedSource.attachmentFingerprint
                : approvedSource.metadataFingerprint;
              const liveFingerprint = ["body", "figure", "quote"].includes(
                sourceKind,
              )
                ? liveFingerprints.attachmentFingerprint
                : liveFingerprints.metadataFingerprint;
              if (!fingerprint || fingerprint !== liveFingerprint) {
                throw new Error(
                  `Paper ${identity} changed after scope approval; revise or refresh the plan`,
                );
              }
              let locator: ResearchEvidenceRecord["locator"];
              if (entry.locator !== undefined) {
                if (!validateObject<Record<string, unknown>>(entry.locator)) {
                  throw new Error(`Evidence ${evidenceKey} locator is invalid`);
                }
                if (!["body", "figure", "quote"].includes(sourceKind)) {
                  throw new Error(
                    `Evidence ${evidenceKey} cannot attach a PDF locator to ${sourceKind}`,
                  );
                }
                const attachmentItemKey = string(
                  entry.locator.attachmentItemKey,
                  "locator.attachmentItemKey",
                );
                const pageIndex = Math.max(
                  0,
                  Math.floor(Number(entry.locator.pageIndex)),
                );
                if (!Number.isFinite(Number(entry.locator.pageIndex))) {
                  throw new Error(
                    `Evidence ${evidenceKey} locator pageIndex is invalid`,
                  );
                }
                const trustedLocator = matchingReadSources.find(
                  (source) =>
                    source.attachmentItemKey === attachmentItemKey &&
                    source.pageIndex === pageIndex,
                );
                if (!trustedLocator) {
                  throw new Error(
                    `Evidence ${evidenceKey} locator was not emitted by its verified read`,
                  );
                }
                locator = {
                  kind: "pdf_page",
                  attachmentItemKey,
                  pageIndex,
                  sourceFingerprint:
                    trustedLocator.sourceFingerprint || fingerprint,
                };
              }
              const evidenceRef = `${job.researchJobId}:${libraryID}:${itemKey}:${safeId(evidenceKey)}`;
              const record: ResearchEvidenceRecord = {
                version: 1,
                evidenceRef,
                researchJobId: job.researchJobId,
                executionId: job.executionId,
                parentTaskId: job.parentTaskId,
                libraryID,
                itemKey,
                sourceFingerprint: fingerprint,
                sourceKind,
                locator,
                createdAt: Date.now(),
              };
              const existing = evidenceByRef.get(evidenceRef);
              if (
                existing &&
                canonicalJson({ ...existing, createdAt: 0 }) !==
                  canonicalJson({ ...record, createdAt: 0 })
              ) {
                throw new Error(
                  `Evidence key ${evidenceKey} was already used with different provenance`,
                );
              }
              if (!existing) await saveResearchEvidence(record);
              evidenceByRef.set(evidenceRef, existing || record);
              evidenceKeyMap.set(evidenceKey, evidenceRef);
              newEvidenceRefs[evidenceKey] = evidenceRef;
            }
            const next: ResearchCorpusItem = {
              ...current,
              screeningStatus: status,
              criterionResults: parsedCriterionResults,
              decisionReason:
                typeof raw.decisionReason === "string"
                  ? raw.decisionReason.trim() || undefined
                  : undefined,
              inventoryRecorded:
                current.inventoryRecorded || recordStage === "inventory",
              hasAbstract:
                typeof raw.hasAbstract === "boolean"
                  ? raw.hasAbstract
                  : current.hasAbstract,
              attachmentItemKeys: Array.isArray(raw.attachmentItemKeys)
                ? strings(
                    raw.attachmentItemKeys,
                    `papers[${index}].attachmentItemKeys`,
                  )
                : current.attachmentItemKeys,
              duplicateAttachmentKeys: Array.isArray(
                raw.duplicateAttachmentKeys,
              )
                ? strings(
                    raw.duplicateAttachmentKeys,
                    `papers[${index}].duplicateAttachmentKeys`,
                  )
                : current.duplicateAttachmentKeys,
              readable:
                typeof raw.readable === "boolean"
                  ? raw.readable
                  : current.readable,
              indexed:
                typeof raw.indexed === "boolean"
                  ? raw.indexed
                  : current.indexed,
              sourceFingerprint:
                liveFingerprints.attachmentFingerprint ||
                liveFingerprints.metadataFingerprint,
              updatedAt: Date.now(),
            };
            await saveResearchCorpusItem(next);
            let workSubquestions: string[] = [];
            if (validateObject<Record<string, unknown>>(raw.finding)) {
              const finding = raw.finding;
              const subquestionIds = strings(
                finding.subquestionIds,
                "finding.subquestionIds",
              );
              workSubquestions = subquestionIds;
              const criterionIds = strings(
                finding.criterionIds,
                "finding.criterionIds",
              );
              if (subquestionIds.some((id) => !allowedSubquestions.has(id))) {
                throw new Error(
                  `Finding for ${identity} references an unknown subquestion`,
                );
              }
              if (criterionIds.some((id) => !allowedCriteria.has(id))) {
                throw new Error(
                  `Finding for ${identity} references an unknown criterion`,
                );
              }
              const mappedEvidence = strings(
                finding.evidenceKeys || [],
                "finding.evidenceKeys",
              ).map((key) => evidenceKeyMap.get(key) || key);
              for (const evidenceRef of mappedEvidence) {
                const evidence = evidenceByRef.get(evidenceRef);
                if (
                  !evidence ||
                  evidence.libraryID !== libraryID ||
                  evidence.itemKey !== itemKey
                ) {
                  throw new Error(
                    `Finding for ${identity} has invalid evidence ${evidenceRef}`,
                  );
                }
              }
              const inclusionDecision =
                finding.inclusionDecision as PaperFinding["inclusionDecision"];
              const confidence =
                finding.confidence as PaperFinding["confidence"];
              if (
                !new Set(["include", "exclude", "unresolved"]).has(
                  inclusionDecision,
                )
              ) {
                throw new Error(
                  `Finding for ${identity} has invalid inclusionDecision`,
                );
              }
              if (!new Set(["low", "medium", "high"]).has(confidence)) {
                throw new Error(
                  `Finding for ${identity} has invalid confidence`,
                );
              }
              const record: PaperFinding = {
                version: 1,
                findingId: `${job.researchJobId}:paper:${libraryID}:${itemKey}`,
                researchJobId: job.researchJobId,
                executionId: job.executionId,
                parentTaskId: job.parentTaskId,
                libraryID,
                itemKey,
                subquestionIds,
                criterionIds,
                findings: strings(finding.findings || [], "finding.findings"),
                contradictions: strings(
                  finding.contradictions || [],
                  "finding.contradictions",
                ),
                negativeEvidence: strings(
                  finding.negativeEvidence || [],
                  "finding.negativeEvidence",
                ),
                limitations: strings(
                  finding.limitations || [],
                  "finding.limitations",
                ),
                evidenceRefs: mappedEvidence,
                sourceFingerprint: next.sourceFingerprint || "missing",
                inclusionDecision,
                confidence,
                unresolvedQuestions: strings(
                  finding.unresolvedQuestions || [],
                  "finding.unresolvedQuestions",
                ),
                createdAt: Date.now(),
              };
              await savePaperFinding(record);
            }
            await completeWorkItem({
              libraryID,
              itemKey,
              stage: input.stage || job.activeStage,
              evidenceRefs: [...evidenceKeyMap.values()],
              subquestionIds: workSubquestions,
            });
          }
        });
      }

      if (input.operation === "record_probes") {
        const kinds = new Set<ResearchRecallProbe["kind"]>([
          "synonym",
          "abbreviation",
          "translation",
          "semantic",
          "reformulation",
        ]);
        const existing = new Map(
          (await listResearchRecallProbes(job.researchJobId)).map((probe) => [
            probe.probeId,
            probe,
          ]),
        );
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 0; index < (input.probes || []).length; index += 1) {
            const raw = input.probes![index];
            if (!validateObject<Record<string, unknown>>(raw)) {
              throw new Error(`probes[${index}] must be an object`);
            }
            const kind = raw.kind as ResearchRecallProbe["kind"];
            if (!kinds.has(kind)) {
              throw new Error(`probes[${index}].kind is invalid`);
            }
            if (!Array.isArray(raw.addedTargets)) {
              throw new Error(`probes[${index}].addedTargets must be an array`);
            }
            const addedTargets = raw.addedTargets.map((target, targetIndex) => {
              if (!validateObject<Record<string, unknown>>(target)) {
                throw new Error(
                  `probes[${index}].addedTargets[${targetIndex}] must be an object`,
                );
              }
              const libraryID = positiveInt(
                target.libraryID,
                `probes[${index}].addedTargets[${targetIndex}].libraryID`,
              );
              const itemKey = string(
                target.itemKey,
                `probes[${index}].addedTargets[${targetIndex}].itemKey`,
              );
              if (!corpusByKey.has(`${libraryID}:${itemKey}`)) {
                throw new Error(
                  `Recall probe target ${libraryID}:${itemKey} is outside the frozen corpus`,
                );
              }
              return { libraryID, itemKey };
            });
            const probeId = `${job.researchJobId}:probe:${safeId(
              string(raw.probeId, `probes[${index}].probeId`),
            )}`;
            const probe: ResearchRecallProbe = {
              version: 1,
              probeId,
              researchJobId: job.researchJobId,
              executionId: job.executionId,
              parentTaskId: job.parentTaskId,
              kind,
              query: string(raw.query, `probes[${index}].query`),
              addedTargets,
              createdAt: existing.get(probeId)?.createdAt || Date.now(),
            };
            const prior = existing.get(probeId);
            if (prior && canonicalJson(prior) !== canonicalJson(probe)) {
              throw new Error(
                `Recall probe ${probeId} changed after persistence`,
              );
            }
            if (!prior) await saveResearchRecallProbe(probe);
          }
        });
      }

      if (input.operation === "record_themes") {
        const paperFindings = await listPaperFindings(job.researchJobId);
        const findingIds = new Set(
          paperFindings.map((entry) => entry.findingId),
        );
        const findingById = new Map(
          paperFindings.map((entry) => [entry.findingId, entry]),
        );
        const evidenceRefs = new Set(evidenceByRef.keys());
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 0; index < (input.themes || []).length; index += 1) {
            const raw = input.themes![index];
            if (!validateObject<Record<string, unknown>>(raw)) {
              throw new Error(`themes[${index}] must be an object`);
            }
            const paperFindingIds = strings(
              raw.paperFindingIds,
              `themes[${index}].paperFindingIds`,
            );
            const themeEvidenceRefs = strings(
              raw.evidenceRefs,
              `themes[${index}].evidenceRefs`,
            );
            if (paperFindingIds.some((id) => !findingIds.has(id))) {
              throw new Error(
                `themes[${index}] references an unknown paper finding`,
              );
            }
            if (themeEvidenceRefs.some((id) => !evidenceRefs.has(id))) {
              throw new Error(`themes[${index}] references unknown evidence`);
            }
            const retainedEvidence = new Set(
              paperFindingIds.flatMap(
                (id) => findingById.get(id)?.evidenceRefs || [],
              ),
            );
            if (themeEvidenceRefs.some((id) => !retainedEvidence.has(id))) {
              throw new Error(
                `themes[${index}] uses evidence not retained by its paper findings`,
              );
            }
            const themeId = safeId(
              string(raw.themeId, `themes[${index}].themeId`),
            );
            const finding: ThemeFinding = {
              version: 1,
              themeFindingId: `${job.researchJobId}:theme:${themeId}`,
              researchJobId: job.researchJobId,
              executionId: job.executionId,
              parentTaskId: job.parentTaskId,
              title: string(raw.title, `themes[${index}].title`),
              synthesis: string(raw.synthesis, `themes[${index}].synthesis`),
              paperFindingIds,
              evidenceRefs: themeEvidenceRefs,
              limitations: strings(
                raw.limitations || [],
                `themes[${index}].limitations`,
              ),
              createdAt: Date.now(),
            };
            await saveThemeFinding(finding);
          }
        });
      }

      let next = await recomputeJob({
        job,
        conversationKey: context.request.conversationKey,
        activeStage: input.stage,
      });
      const checkpointRequired =
        shouldCheckpointResearchExpansion({
          approvedEstimate: investigation.estimatedDeepReadPapers,
          actualDeepReadCandidates: next.candidateItems,
          approvedLargeCorpus: investigation.approvedLargeCorpus,
          policy: next.policy,
        }) && next.deepReadPlanned < next.candidateItems;
      if (checkpointRequired && input.operation !== "finalize") {
        next = await recomputeJob({
          job: next,
          conversationKey: context.request.conversationKey,
          status: "waiting_for_user",
        });
      }

      if (input.operation === "finalize") {
        const allCorpus = await listResearchCorpusItems({
          researchJobId: job.researchJobId,
        });
        const findings = await listPaperFindings(job.researchJobId);
        const themes = await listThemeFindings(job.researchJobId);
        const allEvidence = await listResearchEvidence(job.researchJobId);
        if (input.outcome === "complete") {
          const unfinished = allCorpus.filter(
            (entry) =>
              !entry.inventoryRecorded ||
              ["pending", "candidate"].includes(entry.screeningStatus),
          );
          if (unfinished.length) {
            throw new Error(
              `${unfinished.length} frozen papers are not terminal`,
            );
          }
          const criteriaById = new Map(
            investigation.criteria.map((criterion) => [
              criterion.id,
              criterion,
            ]),
          );
          const invalidDecisions = allCorpus.filter((entry) => {
            if (entry.screeningStatus === "missing") return false;
            const results = investigation.criteria.map(
              (criterion) => entry.criterionResults[criterion.id],
            );
            if (results.some((result) => !result)) return true;
            if (["unresolved", "unreadable"].includes(entry.screeningStatus)) {
              return !results.includes("unknown");
            }
            if (entry.screeningStatus === "included") {
              return investigation.criteria.some((criterion) => {
                const result = entry.criterionResults[criterion.id];
                return criterion.kind === "include"
                  ? result !== "met"
                  : result !== "not_met";
              });
            }
            if (entry.screeningStatus === "excluded") {
              return !Object.entries(entry.criterionResults).some(
                ([criterionId, result]) => {
                  const criterion = criteriaById.get(criterionId);
                  return (
                    (criterion?.kind === "include" && result === "not_met") ||
                    (criterion?.kind === "exclude" && result === "met")
                  );
                },
              );
            }
            return false;
          });
          if (invalidDecisions.length) {
            throw new Error(
              `${invalidDecisions.length} papers lack criterion-complete screening decisions`,
            );
          }
          const findingKeys = new Set(
            findings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
          );
          const findingByKey = new Map(
            findings.map((finding) => [
              `${finding.libraryID}:${finding.itemKey}`,
              finding,
            ]),
          );
          const missingFindings = allCorpus.filter(
            (entry) =>
              entry.screeningStatus !== "missing" &&
              !findingKeys.has(`${entry.libraryID}:${entry.itemKey}`),
          );
          if (missingFindings.length) {
            throw new Error(
              `${missingFindings.length} screened papers lack per-paper findings`,
            );
          }
          const mismatchedFindings = allCorpus.filter((entry) => {
            const finding = findingByKey.get(
              `${entry.libraryID}:${entry.itemKey}`,
            );
            if (!finding) return false;
            const expected =
              entry.screeningStatus === "included"
                ? "include"
                : entry.screeningStatus === "excluded"
                  ? "exclude"
                  : "unresolved";
            return finding.inclusionDecision !== expected;
          });
          if (mismatchedFindings.length) {
            throw new Error(
              `${mismatchedFindings.length} paper findings conflict with screening decisions`,
            );
          }
          if (investigation.requiredEvidenceDepth === "body") {
            const bodyKeys = new Set(
              allEvidence
                .filter((entry) =>
                  ["body", "quote", "figure"].includes(entry.sourceKind),
                )
                .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
            );
            const shallow = allCorpus.filter(
              (entry) =>
                entry.screeningStatus === "included" &&
                !bodyKeys.has(`${entry.libraryID}:${entry.itemKey}`),
            );
            if (shallow.length) {
              throw new Error(
                `${shallow.length} included papers lack required body evidence`,
              );
            }
          }
          if (
            allCorpus.some((entry) => entry.screeningStatus === "included") &&
            !themes.length
          ) {
            throw new Error(
              "Hierarchical synthesis requires at least one durable theme finding",
            );
          }
          const retainedFindingIds = new Set(
            themes.flatMap((theme) => theme.paperFindingIds),
          );
          const unretainedIncluded = findings.filter(
            (finding) =>
              finding.inclusionDecision === "include" &&
              !retainedFindingIds.has(finding.findingId),
          );
          if (unretainedIncluded.length) {
            throw new Error(
              `${unretainedIncluded.length} included paper findings were not retained in hierarchical synthesis`,
            );
          }
        }
        const hasLimitations = allCorpus.some((entry) =>
          ["unresolved", "unreadable", "missing"].includes(
            entry.screeningStatus,
          ),
        );
        const coverageStatus =
          input.outcome === "partial"
            ? "partial"
            : input.outcome === "failed"
              ? "failed"
              : hasLimitations
                ? "complete_with_limitations"
                : "complete";
        next = await recomputeJob({
          job: next,
          conversationKey: context.request.conversationKey,
          activeStage: "hierarchical_synthesis",
          status: input.outcome === "failed" ? "failed" : "completed",
          coverageStatus,
        });
        const ledger = await loadPlanExecutionLedger(plan.executionId);
        const task = ledger?.tasks.find(
          (entry) => entry.taskId === job.parentTaskId,
        );
        const requirement = task?.completionRequirements?.find(
          (entry) => entry.kind === "research_coverage",
        );
        if (!task || !requirement) {
          throw new Error("Research coverage requirement is unavailable");
        }
        await planExecutionCoordinator.attachEvidence({
          version: 2,
          evidenceId: `${job.researchJobId}:coverage:${coverageStatus}`,
          executionId: job.executionId,
          taskId: job.parentTaskId,
          kind: "research_coverage",
          verified: coverageStatus !== "failed",
          requirementId: requirement.requirementId,
          contractDigest: requirement.contractDigest,
          payload: {
            type: "research_coverage",
            researchJobId: job.researchJobId,
            coverageStatus,
            totalItems: next.totalItems,
            screenedItems: next.screenedItems,
            candidateItems: next.candidateItems,
            deepReadCompleted: next.deepReadCompleted,
          },
          reference: job.researchJobId,
          summary: `Coverage ${coverageStatus}: screened ${next.screenedItems}/${next.totalItems}; deep-read ${next.deepReadCompleted}/${next.candidateItems}`,
          createdAt: Date.now(),
        });
      }

      await context.publishPlanEvent?.({
        type: "plan_research_progress",
        progress: progress(next),
      });
      return {
        progress: progress(next),
        inventoriedItems,
        checkpointRequired,
        evidenceRefs: newEvidenceRefs,
      };
    },
  };
}
