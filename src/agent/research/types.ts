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
}>;

export type ResearchScopeSnapshotItem = Readonly<{
  snapshotId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
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
  version: 1;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  contractDigest: string;
  snapshotId: string;
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
  createdAt: number;
}>;

export type ThemeFinding = Readonly<{
  version: 1;
  themeFindingId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  title: string;
  synthesis: string;
  paperFindingIds: readonly string[];
  evidenceRefs: readonly string[];
  limitations: readonly string[];
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
  version: 1;
  grantId: string;
  planId: string;
  planRevision: number;
  executionId: string;
  conversationKey: number;
  planDigest: string;
  researchResultDigest: string;
  targetSetDigest: string;
  actionContract: AgentActionContract;
  status: "approved" | "invalidated";
  approvedAt: number;
  invalidatedAt?: number;
}>;
