import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { canonicalJson } from "../../services/libraryMutation/canonicalJson";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import type {
  LibraryItemTargetAttachment,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { planExecutionCoordinator } from "../../plans/coordinator";
import {
  listExecutionTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../../plans/store";
import {
  shouldCheckpointResearchExpansion,
  type ResearchStage,
} from "../../research/policy";
import { getResearchItemFingerprints } from "../../research/scopeSnapshot";
import {
  claimResearchWorkItems,
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEvidence,
  listResearchRecallProbes,
  listResearchWorkItems,
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
import {
  buildExcludedScreeningFinding,
  buildAdaptiveScreeningBatch,
  type ScreeningBatchPaper,
} from "../../research/screeningBatch";
import { normalizeMaxTokensForRequest } from "../../../utils/llmClient";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchCriterion,
  ResearchEvidenceRecord,
  ResearchJob,
  ResearchProgress,
  ResearchRecallProbe,
  ThemeFinding,
} from "../../research/types";
import type {
  TaskEvidence,
  TrustedReadObservation,
  VerifiedReadSource,
} from "../../plans/types";
import { fail, ok, validateObject } from "../shared";

type ResearchUpdateInput = {
  operation:
    | "inventory_scope"
    | "next_screen_batch"
    | "list_verified_reads"
    | "list_findings"
    | "list_themes"
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
const NARRATIVE_ROLES = [
  "central_evidence",
  "supporting_evidence",
  "contradictory_evidence",
  "theoretical_foundation",
  "methodological_contribution",
  "historical_context",
  "tangential_context",
  "unresolved",
] as const;

export function selectPreferredReadingAttachment(
  attachments: readonly LibraryItemTargetAttachment[],
): LibraryItemTargetAttachment | undefined {
  const pdfs = attachments.filter((attachment) => {
    const contentType = String(attachment.contentType || "")
      .trim()
      .toLowerCase();
    const title = String(attachment.title || "")
      .trim()
      .toLowerCase();
    return contentType === "application/pdf" || title.endsWith(".pdf");
  });
  return pdfs
    .map((attachment, ordinal) => ({
      attachment,
      ordinal,
      score:
        (attachment.mineruCacheDir?.trim() ? 4 : 0) +
        (attachment.indexingState === "indexed"
          ? 3
          : attachment.indexingState === "partial"
            ? 2
            : 0),
    }))
    .sort(
      (left, right) => right.score - left.score || left.ordinal - right.ordinal,
    )[0]?.attachment;
}

type ReadingManifestEntry = {
  identity: string;
  libraryID: number;
  itemKey: string;
  ordinal: number;
  title: string;
  hasAbstract: boolean;
  readable: boolean;
  indexed: boolean;
  evidenceDepthTarget: "metadata" | "abstract" | "body";
  target?: { itemId: number; contextItemId: number };
};

async function buildReadingManifest(params: {
  corpus: readonly ResearchCorpusItem[];
  gateway: ZoteroGateway;
  requiredEvidenceDepth: "metadata" | "abstract" | "body";
  preferredContextItemIds?: ReadonlyMap<string, number>;
}): Promise<ReadingManifestEntry[]> {
  const manifest: ReadingManifestEntry[] = [];
  for (const entry of [...params.corpus].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const identity = `${entry.libraryID}:${entry.itemKey}`;
    const item =
      Zotero.Items.getByLibraryAndKey(entry.libraryID, entry.itemKey) ||
      undefined;
    let preferredContextItemId = params.preferredContextItemIds?.get(identity);
    if (!preferredContextItemId && item) {
      const attachments = await params.gateway.getAllChildAttachmentInfos(
        item.id,
      );
      preferredContextItemId =
        selectPreferredReadingAttachment(attachments)?.contextItemId;
    }
    const attachment = preferredContextItemId
      ? Zotero.Items.get(preferredContextItemId) || undefined
      : undefined;
    manifest.push({
      identity,
      libraryID: entry.libraryID,
      itemKey: entry.itemKey,
      ordinal: entry.ordinal,
      title:
        String(
          item?.getField?.("title") || item?.getDisplayTitle?.() || "",
        ).trim() || "Untitled item",
      hasAbstract: entry.hasAbstract,
      readable: entry.readable,
      indexed: entry.indexed,
      evidenceDepthTarget: entry.readable
        ? params.requiredEvidenceDepth
        : entry.hasAbstract
          ? "abstract"
          : "metadata",
      ...(item
        ? {
            target: {
              itemId: Number(item.id),
              contextItemId: Number(attachment?.id || item.id),
            },
          }
        : {}),
    });
  }
  return manifest;
}

export function isCriterionCompleteScreeningDecision(params: {
  entry: ResearchCorpusItem;
  criteria: readonly ResearchCriterion[];
  totalItems: number;
  deepReadPlanned: number;
}): boolean {
  const { entry, criteria } = params;
  if (entry.screeningStatus === "missing") return true;
  if (!criteria.length) {
    return !["pending", "candidate"].includes(entry.screeningStatus);
  }
  const results = criteria.map(
    (criterion) => entry.criterionResults[criterion.id],
  );
  if (results.some((result) => !result)) return false;
  if (["unresolved", "unreadable"].includes(entry.screeningStatus)) {
    return results.includes("unknown");
  }
  if (entry.screeningStatus === "included") {
    return criteria.every((criterion) => {
      const result = entry.criterionResults[criterion.id];
      return criterion.kind === "include"
        ? result === "met"
        : result === "not_met";
    });
  }
  if (entry.screeningStatus === "excluded") {
    const criteriaExcludePaper = criteria.some((criterion) => {
      const result = entry.criterionResults[criterion.id];
      return (
        (criterion.kind === "include" && result === "not_met") ||
        (criterion.kind === "exclude" && result === "met")
      );
    });
    if (criteriaExcludePaper) return true;

    // In a bounded deep-reading plan, screening is also a relative ranking:
    // papers can satisfy every absolute criterion while still falling outside
    // the strongest subset selected for body reading. Preserve that honest
    // distinction instead of forcing the model to falsify criterion results.
    return (
      params.deepReadPlanned > 0 &&
      params.deepReadPlanned < params.totalItems &&
      Boolean(entry.decisionReason?.trim())
    );
  }
  return true;
}

export function getTerminalScreeningDecisionError(params: {
  screeningStatus: ResearchCorpusItem["screeningStatus"];
  criterionResults: Readonly<Record<string, "met" | "not_met" | "unknown">>;
  decisionReason?: string;
  criteria: readonly ResearchCriterion[];
  totalItems: number;
  deepReadPlanned: number;
}): string | undefined {
  if (["pending", "candidate", "missing"].includes(params.screeningStatus)) {
    return undefined;
  }
  const entry = {
    screeningStatus: params.screeningStatus,
    criterionResults: params.criterionResults,
    decisionReason: params.decisionReason,
  } as ResearchCorpusItem;
  if (
    isCriterionCompleteScreeningDecision({
      entry,
      criteria: params.criteria,
      totalItems: params.totalItems,
      deepReadPlanned: params.deepReadPlanned,
    })
  ) {
    return undefined;
  }
  const rendered = params.criteria
    .map(
      (criterion) =>
        `${criterion.id} (${criterion.kind})=${
          params.criterionResults[criterion.id] || "missing"
        }`,
    )
    .join(", ");
  if (params.screeningStatus === "included") {
    return `screeningStatus "included" is inconsistent with criterionResults: include criteria must be "met" and exclude criteria must be "not_met". Received ${rendered}`;
  }
  if (params.screeningStatus === "excluded") {
    return `screeningStatus "excluded" needs an include criterion marked "not_met", an exclude criterion marked "met", or an explicit decisionReason for relative ranking within a bounded deep-read subset. Received ${rendered}`;
  }
  return `screeningStatus "${params.screeningStatus}" requires at least one criterion marked "unknown". Received ${rendered}`;
}

type PreferredVerifiedRead = Readonly<{
  sourceReadRef: string;
  sources: readonly VerifiedReadSource[];
  observationIds: readonly string[];
  evidenceDepth: "metadata" | "abstract" | "body";
}>;

function verifiedReadDepth(observations: readonly TrustedReadObservation[]) {
  if (
    observations.some((entry) =>
      entry.capabilities.some((capability) =>
        ["body", "figure", "quote"].includes(capability),
      ),
    )
  ) {
    return "body";
  }
  return observations.some((entry) => entry.capabilities.includes("abstract"))
    ? "abstract"
    : "metadata";
}

/**
 * A body receipt can prove that a paper was read without certifying a page.
 * In that case retain the body proof but discard any model-supplied page
 * number. Figure and quote evidence remain page-bound and fail closed.
 */
export function resolveTrustedPdfLocator(params: {
  evidenceKey: string;
  sourceKind: ResearchEvidenceRecord["sourceKind"];
  requested: Readonly<{ attachmentItemKey: string; pageIndex: number }>;
  observations: readonly TrustedReadObservation[];
  fallbackFingerprint: string;
}): ResearchEvidenceRecord["locator"] {
  const locatable = params.observations.filter(
    (observation) =>
      Boolean(observation.attachmentItemKey) &&
      Number.isFinite(observation.pageIndex),
  );
  if (!locatable.length && params.sourceKind === "body") return undefined;
  const trusted = locatable.find(
    (observation) =>
      observation.attachmentItemKey === params.requested.attachmentItemKey &&
      observation.pageIndex === params.requested.pageIndex,
  );
  if (!trusted) {
    throw new Error(
      `Evidence ${params.evidenceKey} locator was not emitted by its verified read`,
    );
  }
  return {
    kind: "pdf_page",
    attachmentItemKey: params.requested.attachmentItemKey,
    pageIndex: params.requested.pageIndex,
    sourceFingerprint: trusted.sourceFingerprint || params.fallbackFingerprint,
  };
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
    const observations = entry.payload.observations || [];
    for (const observation of observations) {
      const identity = `${observation.libraryID}:${observation.itemKey}`;
      if (!corpusIdentities.has(identity)) continue;
      const matchingObservations = observations.filter(
        (candidate) =>
          candidate.libraryID === observation.libraryID &&
          candidate.itemKey === observation.itemKey,
      );
      const matchingSources = matchingObservations.map(
        ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }) => ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }),
      );
      const candidate = {
        sourceReadRef: entry.reference,
        sources: matchingSources,
        observationIds: matchingObservations.map(
          (candidate) => candidate.observationId,
        ),
        evidenceDepth: verifiedReadDepth(matchingObservations),
        createdAt: entry.createdAt,
      } as const;
      const current = selected.get(identity);
      if (
        !current ||
        ["metadata", "abstract", "body"].indexOf(candidate.evidenceDepth) >
          ["metadata", "abstract", "body"].indexOf(current.evidenceDepth) ||
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
        observationIds: entry.observationIds,
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
      "next_screen_batch",
      "list_verified_reads",
      "list_findings",
      "list_themes",
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
    args.papers.length < 1
  ) {
    return fail("record_papers requires at least one paper");
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
      .filter(
        (entry) =>
          entry.version === 2 &&
          Boolean(entry.observationId) &&
          ["body", "figure", "quote"].includes(entry.sourceKind),
      )
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
              "next_screen_batch",
              "list_verified_reads",
              "list_findings",
              "list_themes",
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
            description:
              "Durable paper understandings for any capacity-sized reading group. For adaptive narrative reviews provide the paper identities and rich findings; the host derives descriptive status, criterion fields, and trusted evidence references. Systematic reviews also provide screeningStatus and criterionResults.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["libraryID", "itemKey"],
              properties: {
                libraryID: { type: "integer", minimum: 1 },
                itemKey: { type: "string" },
                screeningStatus: {
                  type: "string",
                  description:
                    "candidate is provisional for deep reading; included means selected for the evidence synthesis and must meet requiredEvidenceDepth; excluded means screened and not selected for deep reading, but the paper remains in frozen coverage.",
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
                    'Map every approved criterion ID to met, not_met, or unknown. Criterion kind controls the direction: an included paper has every include criterion="met" and every exclude criterion="not_met". An excluded paper has an include criterion="not_met" or an exclude criterion="met"; a reasoned relative exclusion may satisfy all absolute criteria when only a bounded subset will be deep-read.',
                  additionalProperties: {
                    type: "string",
                    enum: ["met", "not_met", "unknown"],
                  },
                },
                decisionReason: { type: "string" },
                finding: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "mainMessage",
                    "researchQuestion",
                    "method",
                    "findings",
                    "limitations",
                    "relevance",
                    "confidence",
                  ],
                  properties: {
                    roles: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", enum: NARRATIVE_ROLES },
                    },
                    mainMessage: { type: "string" },
                    researchQuestion: { type: "string" },
                    method: { type: "string" },
                    mechanisms: {
                      type: "array",
                      items: { type: "string" },
                    },
                    relevance: { type: "string" },
                    relationships: {
                      type: "array",
                      items: { type: "string" },
                    },
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
              "Cross-paper relationship themes. Refer to papers by stable libraryID:itemKey identities; the host resolves durable finding and evidence IDs.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["themeId", "title", "synthesis", "limitations"],
              properties: {
                themeId: { type: "string" },
                title: { type: "string" },
                synthesis: { type: "string" },
                paperFindingIds: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
                paperIdentities: {
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
      executionClass: "control",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "For an approved investigation, persist durable understanding instead of administering workflow state in model context. The host has frozen and fingerprinted the exact scope, so never re-enumerate or re-verify it with library_search. First call {operation:'inventory_scope'}; this authoritative scope check returns the unread reading manifest and is safe to repeat after an actual interruption when no continuation manifest is available. For a narrative or scoping review, read one capacity-sized semantic group with paper_read overview, then immediately record rich paper understandings with record_papers before reading more: main message, research question, method, findings, mechanisms, limitations, relevance, descriptive roles, and relationships. The host checkpoints away that group's raw PDF text, and the host binds internal evidence and finding IDs before supplying the exact remaining manifest. A continuation checkpoint already supplies the authoritative remaining manifest: call paper_read directly from it and do not call inventory_scope between durable groups. You must read every accessible paper; never preselect a fixed deep-reading quota or accumulate multiple unrecorded groups. The host supplies criterion/status bookkeeping and advances to synthesis once every paper is durable. Then record cross-paper themes using paperIdentities such as '1:ABCD1234'; the host derives paperFindingIds and evidenceRefs. Call finalize only after themes are recorded. Use targeted reads only to resolve important uncertainty or verify a decisive claim. Missing or inaccessible evidence remains unresolved and its depth must be reported honestly. For a systematic review only, use next_screen_batch, explicit criterion decisions, recall probes, and ordered screening stages. When all papers are durable, call list_findings directly, or list_themes when themes are already durable; do not recover old tool handles or reread completed papers.",
    },
    validate: validateResearchUpdate,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only the active research workflow ledger.",
      }),
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
      const adaptiveReview =
        investigation.readingStrategy === "adaptive" &&
        investigation.reviewMode !== "systematic";
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
      const taskEvidence = await listExecutionTaskEvidence(plan.executionId);
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
              ? entry.payload.observations || []
              : [],
          ]),
      );
      if (input.operation === "next_screen_batch") {
        if (adaptiveReview) {
          throw new Error(
            "Adaptive narrative and scoping reviews read the inventory manifest directly; next_screen_batch is only for systematic review",
          );
        }
        if (job.activeStage !== "broad_screening") {
          throw new Error(
            "next_screen_batch is available only during broad screening",
          );
        }
        if (corpus.some((entry) => !entry.inventoryRecorded)) {
          throw new Error(
            "Inventory is incomplete; call inventory_scope before requesting screening work",
          );
        }
        const pendingCorpus = corpus.filter(
          (entry) => entry.screeningStatus === "pending",
        );
        const activeWork = await listResearchWorkItems({
          researchJobId: job.researchJobId,
          stage: "broad_screening",
          statuses: ["in_progress"],
        });
        const activeIdentities = new Set(
          activeWork.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        );
        const availableCorpus = activeWork.length
          ? pendingCorpus.filter((entry) =>
              activeIdentities.has(`${entry.libraryID}:${entry.itemKey}`),
            )
          : pendingCorpus;
        const materialized: ScreeningBatchPaper[] = availableCorpus.map(
          (entry) => {
            const item = Zotero.Items.getByLibraryAndKey(
              entry.libraryID,
              entry.itemKey,
            );
            const field = (name: string) =>
              String(
                item && item.getField?.(name) ? item.getField(name) : "",
              ).trim();
            return {
              libraryID: entry.libraryID,
              itemKey: entry.itemKey,
              ordinal: entry.ordinal,
              title: field("title") || "Untitled item",
              abstract: field("abstractNote"),
              year: field("year") || field("date") || undefined,
              firstCreator: field("firstCreator") || undefined,
              hasAbstract: entry.hasAbstract,
              readable: entry.readable,
              indexed: entry.indexed,
            };
          },
        );
        const outputTokenBudget = normalizeMaxTokensForRequest({
          value: context.request.advanced?.maxTokens,
          maxTokensExplicit: context.request.advanced?.maxTokensExplicit,
          model: context.request.model || context.modelName,
          apiBase: context.request.apiBase,
          protocol: context.request.providerProtocol,
          authMode: context.request.authMode,
          profileOverride: context.request.advanced?.profileOverride,
        });
        const projected = buildAdaptiveScreeningBatch({
          papers: materialized,
          criterionIds: investigation.criteria.map((entry) => entry.id),
          outputTokenBudget,
          maxPapersPerUpdate: Math.max(1, materialized.length),
        });
        let issued = [...projected.papers];
        if (!activeWork.length && issued.length) {
          const createdAt = Date.now();
          for (const paper of issued) {
            const workItemId = `${job.researchJobId}:work:broad_screening:${paper.libraryID}:${paper.itemKey}`;
            if (await loadResearchWorkItem(workItemId)) continue;
            await saveResearchWorkItem({
              version: 1,
              workItemId,
              researchJobId: job.researchJobId,
              executionId: job.executionId,
              parentTaskId: job.parentTaskId,
              libraryID: paper.libraryID,
              itemKey: paper.itemKey,
              stage: "broad_screening",
              subquestionIds: [],
              status: "pending",
              attemptCount: 0,
              evidenceRefs: [],
              createdAt: createdAt + paper.ordinal,
              updatedAt: createdAt,
            });
          }
          const claimed = await claimResearchWorkItems({
            researchJobId: job.researchJobId,
            stage: "broad_screening",
            leaseOwner: context.runId || job.executionId,
            limit: issued.length,
          });
          const claimedIdentities = new Set(
            claimed.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
          );
          issued = issued.filter((paper) =>
            claimedIdentities.has(`${paper.libraryID}:${paper.itemKey}`),
          );
        }
        const next = await recomputeJob({
          job,
          conversationKey: context.request.conversationKey,
        });
        return {
          researchContract: {
            question: investigation.question,
            criteria: investigation.criteria,
            subquestions: investigation.subquestions,
            requiredEvidenceDepth: investigation.requiredEvidenceDepth,
          },
          batch: {
            batchId: issued.length
              ? `${job.researchJobId}:screen:${issued[0].ordinal}-${issued[issued.length - 1].ordinal}`
              : undefined,
            papers: issued,
            pendingPapers: pendingCorpus.length,
            remainingAfterCommit: Math.max(
              0,
              pendingCorpus.length - issued.length,
            ),
            resumed: activeWork.length > 0,
          },
          instruction: issued.length
            ? "Classify every paper in this batch against every criterion, then immediately call research_update record_papers with exactly these identities. Do not analyze another batch first."
            : "Broad screening is durable for the complete frozen corpus; advance to recall_expansion.",
          progress: progress(next),
        };
      }
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
            .filter(
              (entry) =>
                entry.version === 2 &&
                Boolean(entry.observationId) &&
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
        const preferredByPaper = selectPreferredVerifiedReads(
          taskEvidence,
          new Set(corpusByKey.keys()),
        );
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
          title: snapshotByKey.get(`${finding.libraryID}:${finding.itemKey}`)
            ?.title,
          firstCreator: snapshotByKey.get(
            `${finding.libraryID}:${finding.itemKey}`,
          )?.firstCreator,
          year: snapshotByKey.get(`${finding.libraryID}:${finding.itemKey}`)
            ?.year,
          evidenceDepth:
            preferredByPaper.get(`${finding.libraryID}:${finding.itemKey}`)
              ?.evidenceDepth || "metadata",
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
          roles: finding.roles,
          mainMessage: finding.mainMessage,
          researchQuestion: finding.researchQuestion,
          method: finding.method,
          mechanisms: finding.mechanisms,
          relevance: finding.relevance,
          relationships: finding.relationships,
        }));
        const nextCursor = cursor + page.length;
        return {
          findings: page,
          nextCursor: nextCursor < findings.length ? nextCursor : null,
          totalFindings: findings.length,
        };
      }
      if (input.operation === "list_themes") {
        const themes = await listThemeFindings(job.researchJobId);
        return {
          themes: themes.map((theme) => ({
            themeFindingId: theme.themeFindingId,
            title: theme.title,
            synthesis: theme.synthesis,
            paperFindingIds: theme.paperFindingIds,
            evidenceRefs: theme.evidenceRefs,
            limitations: theme.limitations,
          })),
          totalThemes: themes.length,
          instruction: themes.length
            ? "Use these durable theme reductions for the synthesis task and document; do not recover old tool handles or reread papers."
            : "No durable themes are recorded yet; synthesize from list_findings and persist them with record_themes.",
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
      const resumesAdaptiveInventory =
        adaptiveReview &&
        input.operation === "inventory_scope" &&
        effectiveStage !== "inventory";
      if (
        input.operation === "inventory_scope" &&
        effectiveStage !== "inventory" &&
        !resumesAdaptiveInventory
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
        input.operation === "record_papers" &&
        effectiveStage === "broad_screening" &&
        !adaptiveReview
      ) {
        const issued = await listResearchWorkItems({
          researchJobId: job.researchJobId,
          stage: "broad_screening",
          statuses: ["in_progress"],
        });
        if (!issued.length) {
          throw new Error(
            "Call next_screen_batch before recording broad-screening decisions",
          );
        }
        const expected = new Set(
          issued.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        );
        const submitted = new Set(
          (input.papers || []).map((paper) =>
            validateObject<Record<string, unknown>>(paper)
              ? `${Number(paper.libraryID)}:${String(paper.itemKey || "")}`
              : "invalid",
          ),
        );
        if (
          expected.size !== submitted.size ||
          [...expected].some((identity) => !submitted.has(identity))
        ) {
          throw new Error(
            "record_papers must commit exactly the current host-issued screening batch before more work is issued",
          );
        }
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
      let readingManifest: ReadingManifestEntry[] | undefined;
      if (input.operation === "inventory_scope") {
        if (resumesAdaptiveInventory) {
          const findings = await listPaperFindings(job.researchJobId);
          const recordedIdentities = new Set(
            findings.map(
              (finding) => `${finding.libraryID}:${finding.itemKey}`,
            ),
          );
          readingManifest = await buildReadingManifest({
            corpus: corpus.filter(
              (entry) =>
                entry.screeningStatus !== "missing" &&
                !recordedIdentities.has(`${entry.libraryID}:${entry.itemKey}`),
            ),
            gateway,
            requiredEvidenceDepth: investigation.requiredEvidenceDepth,
          });
          inventoriedItems = corpus.filter(
            (entry) => entry.inventoryRecorded,
          ).length;
        } else {
          let recorded = 0;
          const preferredReadingContextIds = new Map<string, number>();
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
            const preferredReadingAttachment =
              selectPreferredReadingAttachment(attachmentInfos);
            if (preferredReadingAttachment) {
              preferredReadingContextIds.set(
                identity,
                preferredReadingAttachment.contextItemId,
              );
            }
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
              if (
                !attachmentInfos.some(
                  (info) =>
                    info.contextItemId === attachment.id &&
                    selectPreferredReadingAttachment([info]),
                )
              ) {
                continue;
              }
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
          const inventoriedCorpus = await listResearchCorpusItems({
            researchJobId: job.researchJobId,
          });
          readingManifest = await buildReadingManifest({
            corpus: inventoriedCorpus,
            gateway,
            requiredEvidenceDepth: investigation.requiredEvidenceDepth,
            preferredContextItemIds: preferredReadingContextIds,
          });
        }
      }

      if (input.operation === "record_papers") {
        const preferredReads = selectPreferredVerifiedReads(
          taskEvidence,
          new Set(corpusByKey.keys()),
        );
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
            const status = (raw.screeningStatus ||
              (adaptiveReview
                ? current.readable
                  ? "included"
                  : current.hasAbstract
                    ? "unresolved"
                    : "unreadable"
                : undefined)) as ResearchCorpusItem["screeningStatus"];
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
            const decisionReason =
              typeof raw.decisionReason === "string"
                ? raw.decisionReason.trim() || undefined
                : undefined;
            const decisionError = getTerminalScreeningDecisionError({
              screeningStatus: status,
              criterionResults: parsedCriterionResults,
              decisionReason,
              criteria: investigation.criteria,
              totalItems: job.totalItems,
              deepReadPlanned: job.deepReadPlanned,
            });
            if (decisionError) {
              throw new Error(`papers[${index}] ${decisionError}`);
            }
            const evidenceKeyMap = new Map<string, string>();
            const preferredRead = preferredReads.get(identity);
            const rawEvidence = adaptiveReview
              ? preferredRead
                ? [
                    {
                      evidenceKey: "host_verified_read",
                      sourceKind: preferredRead.evidenceDepth,
                      sourceReadRef: preferredRead.sourceReadRef,
                    },
                  ]
                : []
              : Array.isArray(raw.evidence)
                ? raw.evidence
                : [];
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
              const readObservations = verifiedReads.get(sourceReadRef) || [];
              const matchingReadObservations = readObservations.filter(
                (observation) =>
                  observation.libraryID === libraryID &&
                  observation.itemKey === itemKey &&
                  observation.capabilities.includes(sourceKind),
              );
              if (!matchingReadObservations.length) {
                throw new Error(
                  `Evidence ${evidenceKey} sourceKind ${sourceKind} was not issued by a trusted observation of ${identity}`,
                );
              }
              const trustedObservation = matchingReadObservations[0];
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
                locator = resolveTrustedPdfLocator({
                  evidenceKey,
                  sourceKind,
                  requested: {
                    attachmentItemKey,
                    pageIndex,
                  },
                  observations: matchingReadObservations,
                  fallbackFingerprint: fingerprint,
                });
              }
              const evidenceRef = `${job.researchJobId}:${libraryID}:${itemKey}:${safeId(evidenceKey)}`;
              const record: ResearchEvidenceRecord = {
                version: 2,
                evidenceRef,
                researchJobId: job.researchJobId,
                executionId: job.executionId,
                parentTaskId: job.parentTaskId,
                libraryID,
                itemKey,
                sourceFingerprint: fingerprint,
                sourceKind,
                observationId: trustedObservation.observationId,
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
              decisionReason,
              inventoryRecorded:
                current.inventoryRecorded || recordStage === "inventory",
              // Inventory and attachment identity are authoritative host state.
              // A model-produced paper understanding must never narrow or
              // otherwise rewrite the inventory that was frozen during the
              // scope pass.
              hasAbstract: current.hasAbstract,
              attachmentItemKeys: current.attachmentItemKeys,
              duplicateAttachmentKeys: current.duplicateAttachmentKeys,
              readable: current.readable,
              indexed: current.indexed,
              sourceFingerprint:
                liveFingerprints.attachmentFingerprint ||
                liveFingerprints.metadataFingerprint,
              updatedAt: Date.now(),
            };
            await saveResearchCorpusItem(next);
            let workSubquestions: string[] = [];
            if (validateObject<Record<string, unknown>>(raw.finding)) {
              const finding = raw.finding;
              const subquestionIds =
                adaptiveReview && finding.subquestionIds === undefined
                  ? [...allowedSubquestions]
                  : strings(finding.subquestionIds, "finding.subquestionIds");
              workSubquestions = subquestionIds;
              const criterionIds =
                adaptiveReview && finding.criterionIds === undefined
                  ? []
                  : strings(finding.criterionIds, "finding.criterionIds");
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
              const evidenceKeys = [...evidenceKeyMap.keys()];
              const mappedEvidence = evidenceKeys.map(
                (key) => evidenceKeyMap.get(key) || key,
              );
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
              const inclusionDecision = (finding.inclusionDecision ||
                (adaptiveReview
                  ? status === "included"
                    ? "include"
                    : "unresolved"
                  : undefined)) as PaperFinding["inclusionDecision"];
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
              const roles =
                finding.roles === undefined
                  ? adaptiveReview
                    ? status === "included"
                      ? ["supporting_evidence"]
                      : ["unresolved"]
                    : undefined
                  : strings(finding.roles, "finding.roles");
              if (
                roles?.some(
                  (role) =>
                    !(NARRATIVE_ROLES as readonly string[]).includes(role),
                )
              ) {
                throw new Error(`Finding for ${identity} has an invalid role`);
              }
              if (adaptiveReview && status === "included") {
                for (const field of [
                  "mainMessage",
                  "researchQuestion",
                  "method",
                  "relevance",
                ] as const) {
                  string(finding[field], `finding.${field}`);
                }
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
                ...(roles
                  ? {
                      roles: roles as NonNullable<PaperFinding["roles"]>,
                    }
                  : {}),
                ...(finding.mainMessage === undefined
                  ? {}
                  : {
                      mainMessage: string(
                        finding.mainMessage,
                        "finding.mainMessage",
                      ),
                    }),
                ...(finding.researchQuestion === undefined
                  ? {}
                  : {
                      researchQuestion: string(
                        finding.researchQuestion,
                        "finding.researchQuestion",
                      ),
                    }),
                ...(finding.method === undefined
                  ? {}
                  : { method: string(finding.method, "finding.method") }),
                ...(finding.mechanisms === undefined
                  ? {}
                  : {
                      mechanisms: strings(
                        finding.mechanisms,
                        "finding.mechanisms",
                      ),
                    }),
                ...(finding.relevance === undefined
                  ? {}
                  : {
                      relevance: string(finding.relevance, "finding.relevance"),
                    }),
                ...(finding.relationships === undefined
                  ? {}
                  : {
                      relationships: strings(
                        finding.relationships,
                        "finding.relationships",
                      ),
                    }),
                createdAt: Date.now(),
              };
              await savePaperFinding(record);
            } else if (adaptiveReview && status !== "missing") {
              throw new Error(
                `Adaptive review paper ${identity} requires a durable finding`,
              );
            } else if (
              recordStage === "broad_screening" &&
              status === "excluded"
            ) {
              await savePaperFinding(
                buildExcludedScreeningFinding({
                  researchJobId: job.researchJobId,
                  executionId: job.executionId,
                  parentTaskId: job.parentTaskId,
                  libraryID,
                  itemKey,
                  criterionIds: [...allowedCriteria],
                  decisionReason: next.decisionReason,
                  sourceFingerprint: next.sourceFingerprint || "missing",
                }),
              );
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
        const findingByIdentity = new Map(
          paperFindings.map((entry) => [
            `${entry.libraryID}:${entry.itemKey}`,
            entry,
          ]),
        );
        const evidenceRefs = new Set(evidenceByRef.keys());
        await Zotero.DB.executeTransaction(async () => {
          for (let index = 0; index < (input.themes || []).length; index += 1) {
            const raw = input.themes![index];
            if (!validateObject<Record<string, unknown>>(raw)) {
              throw new Error(`themes[${index}] must be an object`);
            }
            const paperFindingIds = [
              ...(raw.paperFindingIds === undefined
                ? []
                : strings(
                    raw.paperFindingIds,
                    `themes[${index}].paperFindingIds`,
                  )),
              ...(raw.paperIdentities === undefined
                ? []
                : strings(
                    raw.paperIdentities,
                    `themes[${index}].paperIdentities`,
                  ).map((identity) => {
                    const finding = findingByIdentity.get(identity);
                    if (!finding) {
                      throw new Error(
                        `themes[${index}] references unknown paper identity ${identity}`,
                      );
                    }
                    return finding.findingId;
                  })),
            ].filter((id, position, all) => all.indexOf(id) === position);
            if (!paperFindingIds.length) {
              throw new Error(
                `themes[${index}] requires paperIdentities or paperFindingIds`,
              );
            }
            const themeEvidenceRefs =
              raw.evidenceRefs === undefined
                ? [
                    ...new Set(
                      paperFindingIds.flatMap(
                        (id) => findingById.get(id)?.evidenceRefs || [],
                      ),
                    ),
                  ]
                : strings(raw.evidenceRefs, `themes[${index}].evidenceRefs`);
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

      let automaticStage = input.stage;
      let remainingReadingManifest: ReadingManifestEntry[] | undefined;
      if (
        adaptiveReview &&
        input.operation === "inventory_scope" &&
        job.activeStage === "inventory"
      ) {
        automaticStage = "broad_screening";
      }
      if (adaptiveReview && input.operation === "record_papers") {
        const [currentCorpus, currentFindings] = await Promise.all([
          listResearchCorpusItems({ researchJobId: job.researchJobId }),
          listPaperFindings(job.researchJobId),
        ]);
        const findingKeys = new Set(
          currentFindings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        );
        const everyPaperUnderstood = currentCorpus.every(
          (entry) =>
            entry.screeningStatus === "missing" ||
            (!["pending", "candidate"].includes(entry.screeningStatus) &&
              findingKeys.has(`${entry.libraryID}:${entry.itemKey}`)),
        );
        if (everyPaperUnderstood) {
          automaticStage = "hierarchical_synthesis";
          remainingReadingManifest = [];
        } else {
          remainingReadingManifest = await buildReadingManifest({
            corpus: currentCorpus.filter(
              (entry) =>
                entry.screeningStatus !== "missing" &&
                !findingKeys.has(`${entry.libraryID}:${entry.itemKey}`),
            ),
            gateway,
            requiredEvidenceDepth: investigation.requiredEvidenceDepth,
          });
        }
      }
      let next = await recomputeJob({
        job,
        conversationKey: context.request.conversationKey,
        activeStage: automaticStage,
      });
      const checkpointRequired =
        !adaptiveReview &&
        shouldCheckpointResearchExpansion({
          approvedEstimate: investigation.estimatedDeepReadPapers,
          actualDeepReadCandidates: next.candidateItems,
          approvedLargeCorpus: investigation.approvedLargeCorpus,
          policy: next.policy,
        }) &&
        next.deepReadPlanned < next.candidateItems;
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
        if (input.outcome === "partial") {
          const grant = next.exceptionGrant;
          const countersMatch =
            grant?.totalItems === next.totalItems &&
            grant.screenedItems === next.screenedItems &&
            grant.candidateItems === next.candidateItems &&
            grant.deepReadCompleted === next.deepReadCompleted;
          if (
            !grant ||
            grant.status !== "authorized" ||
            grant.planDigest !== artifact.digest ||
            grant.executionId !== next.executionId ||
            grant.researchJobId !== next.researchJobId ||
            !countersMatch
          ) {
            throw new Error(
              "Partial research finalization requires a current user-authorized ResearchExceptionGrant from the expansion checkpoint",
            );
          }
        }
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
          const invalidDecisions = allCorpus.filter(
            (entry) =>
              !isCriterionCompleteScreeningDecision({
                entry,
                criteria: investigation.criteria,
                totalItems: next.totalItems,
                deepReadPlanned: next.deepReadPlanned,
              }),
          );
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
                .filter(
                  (entry) =>
                    entry.version === 2 &&
                    Boolean(entry.observationId) &&
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
              const identities = shallow
                .map((entry) => `${entry.libraryID}:${entry.itemKey}`)
                .join(", ");
              throw new Error(
                `${shallow.length} included papers lack required body evidence: ${identities}. Deep-read them, or if they were screened but not selected for the bounded deep-read subset, record screeningStatus "excluded" with an explicit relative-ranking decisionReason; excluded papers remain in frozen coverage.`,
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
          job:
            input.outcome === "partial" && next.exceptionGrant
              ? {
                  ...next,
                  exceptionGrant: {
                    ...next.exceptionGrant,
                    status: "consumed",
                    consumedAt: Date.now(),
                  },
                }
              : next,
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
          version: 3,
          evidenceId: `${job.researchJobId}:coverage:${coverageStatus}`,
          executionId: job.executionId,
          taskId: job.parentTaskId,
          kind: "research_coverage",
          verified:
            coverageStatus === "complete" ||
            coverageStatus === "complete_with_limitations",
          requirementId: requirement.requirementId,
          criterionIds: requirement.criterionIds,
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
        if (coverageStatus === "partial") {
          let exceptionLedger =
            await planExecutionCoordinator.requestTransition({
              executionId: job.executionId,
              taskId: job.parentTaskId,
              toStatus: "skipped",
              requestedBy: "user",
              reason: next.exceptionGrant?.limitationSummary,
            });
          exceptionLedger = await planExecutionCoordinator.startNextTask(
            job.executionId,
          );
          await context.publishPlanEvent?.({
            type: "plan_execution_updated",
            ledger: exceptionLedger,
          });
        } else if (
          coverageStatus === "complete" ||
          coverageStatus === "complete_with_limitations"
        ) {
          const advancedLedger =
            await planExecutionCoordinator.advanceVerifiedTasks({
              executionId: job.executionId,
              requirementKinds: ["verified_read", "research_coverage"],
            });
          await context.publishPlanEvent?.({
            type: "plan_execution_updated",
            ledger: advancedLedger,
          });
        }
      }

      await context.publishPlanEvent?.({
        type: "plan_research_progress",
        progress: progress(next),
      });
      const content = {
        progress: progress(next),
        inventoriedItems,
        ...(readingManifest
          ? {
              readingManifest,
              instruction: adaptiveReview
                ? readingManifest.length
                  ? "Read one capacity-sized semantic group with paper_read overview, then immediately record a rich understanding for every identity in that group before reading more. The host will checkpoint raw text and return the exact remaining manifest."
                  : "No unread papers remain. Continue from list_findings or list_themes without rereading PDFs."
                : "Request the next systematic-review screening batch.",
            }
          : {}),
        checkpointRequired,
        evidenceRefs: newEvidenceRefs,
      };
      if (
        adaptiveReview &&
        input.operation === "record_papers" &&
        remainingReadingManifest
      ) {
        const compactRemainingManifest = remainingReadingManifest.map(
          (entry) => ({
            identity: entry.identity,
            title: entry.title,
            readable: entry.readable,
            evidenceDepthTarget: entry.evidenceDepthTarget,
            target: entry.target,
          }),
        );
        if (!compactRemainingManifest.length) {
          const advancedLedger =
            await planExecutionCoordinator.advanceVerifiedTasks({
              executionId: job.executionId,
              requirementKinds: ["verified_read"],
            });
          await context.publishPlanEvent?.({
            type: "plan_execution_updated",
            ledger: advancedLedger,
          });
        }
        return {
          content,
          continuationCheckpoint: {
            reason: "research_batch_durable",
            instruction: compactRemainingManifest.length
              ? `The completed paper-understanding group is durable. Raw PDF text from that group has been released. The exact remaining frozen-scope manifest below is authoritative. Do not call inventory_scope or otherwise re-verify it. Call paper_read now for one capacity-sized semantic group from this manifest, immediately persist that group with research_update record_papers, and do not reread recorded papers.\n\n${JSON.stringify(compactRemainingManifest)}`
              : "All paper understandings are durable and the raw PDF text has been released. Do not call inventory_scope again. Call research_update list_findings now, build and persist the cross-paper themes, finalize research, and do not reread the PDFs unless resolving a decisive uncertainty.",
          },
        };
      }
      return content;
    },
  };
}
