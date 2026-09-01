import type {
  AgentActionContract,
  AgentActionReceipt,
} from "../contracts/types";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";

export type PlanProvider = "original" | "codex" | "claude";

export type PlanArtifactStatus =
  | "drafting"
  | "awaiting_approval"
  | "approved"
  | "superseded"
  | "cancelled";

export type PlanStepEffect = "read" | "artifact" | "mutation" | "reasoning";

export type PlanStep = Readonly<{
  planStepId: string;
  content: string;
  activeForm: string;
  acceptanceCriteria: readonly string[];
  expectedCapability?: string;
  expectedEffect: PlanStepEffect;
  targetBoundary?: Readonly<{
    kind: "collection" | "library" | "selection" | "conversation";
    targetIds?: readonly string[];
    scopeDigest?: string;
  }>;
}>;

/** A revision is editable only while drafting and is frozen by approval. */
export type PlanArtifact = Readonly<{
  version: 1 | 2;
  planId: string;
  conversationKey: number;
  provider: PlanProvider;
  revision: number;
  digest: string;
  status: PlanArtifactStatus;
  explanation?: string;
  actionContractId?: string;
  /** Frozen scope/effect contract that the approval grant authorizes. */
  actionContract?: AgentActionContract;
  sourceRunId?: string;
  /** Present on v2 artifacts; binds planning-time skill instructions. */
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
  steps: readonly PlanStep[];
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
}>;

export type ExecutionTaskStatus =
  | "pending"
  | "in_progress"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "cancelled";

export type ExecutionTaskKind = "required_step" | "supporting_child";

export type TaskEvidenceKind =
  | "mutation_receipt"
  | "verified_read"
  | "artifact"
  | "validation"
  | "reasoning_assertion";

export type TaskEvidence = Readonly<{
  version: 1;
  evidenceId: string;
  executionId: string;
  taskId: string;
  kind: TaskEvidenceKind;
  verified: boolean;
  receipt?: AgentActionReceipt;
  reference?: string;
  summary?: string;
  createdAt: number;
}>;

export type ExecutionTask = Readonly<{
  version: 1;
  taskId: string;
  executionId: string;
  planStepId: string;
  parentTaskId?: string;
  kind: ExecutionTaskKind;
  content: string;
  activeForm: string;
  acceptanceCriteria: readonly string[];
  expectedEffect: PlanStepEffect;
  expectedCapability?: string;
  obligationIds: readonly string[];
  status: ExecutionTaskStatus;
  attemptCount: number;
  evidenceIds: readonly string[];
  failureReasons: readonly string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}>;

export type PlanExecutionStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "completed_with_exceptions"
  | "blocked"
  | "failed"
  | "cancelled";

export type ApprovedPlanGrant = Readonly<{
  version: 1;
  planId: string;
  revision: number;
  planDigest: string;
  conversationKey: number;
  conversationGeneration: number;
  actionContractId?: string;
  approvedAt: number;
}>;

export type PlanExecutionLedger = Readonly<{
  version: 1;
  executionId: string;
  planId: string;
  revision: number;
  planDigest: string;
  conversationKey: number;
  attempt: number;
  provider: PlanProvider;
  providerContinuationId?: string;
  actionContractId?: string;
  grant: ApprovedPlanGrant;
  status: PlanExecutionStatus;
  activeTaskId?: string;
  tasks: readonly ExecutionTask[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}>;

export type TaskTransitionRequest = Readonly<{
  executionId: string;
  taskId: string;
  toStatus: ExecutionTaskStatus;
  reason?: string;
  evidenceIds?: readonly string[];
  requestedBy: PlanProvider | "host" | "user";
}>;

export type PlanRuntimeContext =
  | Readonly<{
      phase: "planning";
      planId: string;
      revision: number;
      provider: PlanProvider;
    }>
  | Readonly<{
      phase: "executing";
      planId: string;
      revision: number;
      executionId: string;
      approvedDigest: string;
      activeTaskId?: string;
      provider: PlanProvider;
    }>;

export type PlanEvent =
  | {
      type: "plan_updated";
      artifact: PlanArtifact;
    }
  | {
      type: "plan_ready";
      artifact: PlanArtifact;
    }
  | {
      type: "plan_execution_updated";
      ledger: PlanExecutionLedger;
      transition?: Readonly<{
        taskId: string;
        fromStatus: ExecutionTaskStatus;
        toStatus: ExecutionTaskStatus;
        text: string;
      }>;
    };
