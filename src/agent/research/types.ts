import type { ResearchPolicySnapshot, ResearchStage } from "./policy";
import type { AgentActionContract } from "../contracts/types";

export type ResearchCoverageStatus =
  | "complete"
  | "complete_with_limitations"
  | "partial"
  | "failed";

export type ResearchScopeSpec = Readonly<{
  libraryID: number;
}> &
  (
    | Readonly<{ kind: "library" }>
    | Readonly<{ kind: "collections"; collectionIds: readonly number[] }>
    | Readonly<{
        kind: "tags";
        tagNames: readonly string[];
        includeAutomaticTags?: boolean;
      }>
    | Readonly<{ kind: "items"; itemKeys: readonly string[] }>
    | Readonly<{
        kind: "mixed";
        collectionIds?: readonly number[];
        tagNames?: readonly string[];
        includeAutomaticTags?: boolean;
        itemKeys?: readonly string[];
      }>
  );

export type ResearchCriterion = Readonly<{
  id: string;
  description: string;
  kind: "include" | "exclude";
}>;

export type ResearchSubquestion = Readonly<{
  id: string;
  question: string;
}>;

export type ResearchContract = Readonly<{
  question: string;
  subquestions: readonly ResearchSubquestion[];
  criteria: readonly ResearchCriterion[];
  /** Narrative is the ordinary literature-review default. */
  reviewMode?: "narrative" | "scoping" | "systematic";
  /** Adaptive reads the approved scope to the depth allowed by live capacity. */
  readingStrategy?: "adaptive" | "selected";
  /** Whether execution may add papers proven to remain inside the source. */
  scopeAmendmentPolicy: "fixed" | "within_source";
  scope: ResearchScopeSpec;
  /** Required once the plan is ready for approval. */
  scopeSnapshot?: ResearchScopeSnapshotRef;
  queryVariants?: readonly string[];
  requiredEvidenceDepth: "metadata" | "abstract" | "body";
  estimatedDeepReadPapers: number;
  approvedLargeCorpus: boolean;
}>;

export type ResearchScopeSnapshotRef = Readonly<{
  snapshotId: string;
  digest: string;
  itemCount: number;
  createdAt: number;
  policyVersion: number;
  parentSnapshotId?: string;
  scopeLineageDigest?: string;
}>;

export type ResearchScopeSnapshotItem = Readonly<{
  snapshotId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
  /** Frozen display metadata used by recovery and final coverage reporting. */
  title?: string;
  firstCreator?: string;
  year?: string;
  metadataFingerprint?: string;
  attachmentFingerprint?: string;
  ordinal: number;
}>;

export type ResearchJobStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type ResearchScreeningStatus =
  | "pending"
  | "candidate"
  | "included"
  | "excluded"
  | "unresolved"
  | "unreadable"
  | "missing";

export type ResearchWorkStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type ResearchJob = Readonly<{
  version: 1 | 2;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  contractDigest: string;
  /** The snapshot frozen into the initially approved Plan artifact. */
  baseSnapshotId?: string;
  /** The current immutable effective snapshot for this execution. */
  snapshotId: string;
  /** Digest of the complete base-to-effective snapshot lineage. */
  scopeLineageDigest?: string;
  policy: ResearchPolicySnapshot;
  status: ResearchJobStatus;
  activeStage: ResearchStage;
  coverageStatus?: ResearchCoverageStatus;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  deepReadPlanned: number;
  exceptionGrant?: ResearchExceptionGrant;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}>;

export type ResearchExceptionGrant = Readonly<{
  version: 1;
  grantId: string;
  planDigest: string;
  executionId: string;
  researchJobId: string;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  limitationSummary: string;
  status: "authorized" | "consumed";
  grantedAt: number;
  consumedAt?: number;
}>;

export type ResearchCorpusItem = Readonly<{
  version: 1;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
  ordinal: number;
  screeningStatus: ResearchScreeningStatus;
  criterionResults: Readonly<Record<string, "met" | "not_met" | "unknown">>;
  decisionReason?: string;
  inventoryRecorded: boolean;
  hasAbstract: boolean;
  attachmentItemKeys: readonly string[];
  duplicateAttachmentKeys: readonly string[];
  readable: boolean;
  indexed: boolean;
  sourceFingerprint?: string;
  updatedAt: number;
}>;

export type ResearchWorkItem = Readonly<{
  version: 1;
  workItemId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  stage: ResearchStage;
  subquestionIds: readonly string[];
  status: ResearchWorkStatus;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  evidenceRefs: readonly string[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type ResearchEvidenceRecord = Readonly<{
  version: 1 | 2;
  evidenceRef: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  sourceFingerprint: string;
  sourceKind: "metadata" | "abstract" | "body" | "figure" | "quote";
  /** Required on v2 evidence; points to host-issued observation metadata. */
  observationId?: string;
  locator?: Readonly<{
    kind: "pdf_page";
    attachmentItemKey: string;
    pageIndex: number;
    sourceFingerprint: string;
  }>;
  createdAt: number;
}>;

export type ResearchRecallProbe = Readonly<{
  version: 1;
  probeId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  kind:
    | "synonym"
    | "abbreviation"
    | "translation"
    | "semantic"
    | "reformulation";
  query: string;
  addedTargets: readonly Readonly<{ libraryID: number; itemKey: string }>[];
  createdAt: number;
}>;

export type ResearchFindingConfidence = "low" | "medium" | "high";

export type PaperFinding = Readonly<{
  version: 1;
  findingId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  subquestionIds: readonly string[];
  criterionIds: readonly string[];
  findings: readonly string[];
  contradictions: readonly string[];
  negativeEvidence: readonly string[];
  limitations: readonly string[];
  evidenceRefs: readonly string[];
  sourceFingerprint: string;
  inclusionDecision: "include" | "exclude" | "unresolved";
  confidence: ResearchFindingConfidence;
  unresolvedQuestions: readonly string[];
  /** Descriptive, non-exclusive roles used by narrative evidence synthesis. */
  roles?: readonly (
    | "central_evidence"
    | "supporting_evidence"
    | "contradictory_evidence"
    | "theoretical_foundation"
    | "methodological_contribution"
    | "historical_context"
    | "tangential_context"
    | "unresolved"
  )[];
  mainMessage?: string;
  researchQuestion?: string;
  method?: string;
  mechanisms?: readonly string[];
  relevance?: string;
  relationships?: readonly string[];
  createdAt: number;
}>;

export type ThemeFinding = Readonly<{
  version: 1 | 2;
  themeFindingId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  title: string;
  synthesis: string;
  paperFindingIds: readonly string[];
  evidenceRefs: readonly string[];
  limitations: readonly string[];
  scopeLineageDigest?: string;
  status?: "valid" | "invalidated";
  invalidatedAt?: number;
  createdAt: number;
}>;

export type ResearchProgress = Readonly<{
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  stage: ResearchStage;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  deepReadPlanned: number;
  coverageStatus?: ResearchCoverageStatus;
}>;

export type ResearchMutationApprovalGrant = Readonly<{
  version: 1 | 2;
  grantId: string;
  planId: string;
  planRevision: number;
  executionId: string;
  conversationKey: number;
  planDigest: string;
  researchResultDigest: string;
  scopeLineageDigest?: string;
  targetSetDigest: string;
  actionContract: AgentActionContract;
  status: "approved" | "invalidated";
  approvedAt: number;
  invalidatedAt?: number;
}>;
