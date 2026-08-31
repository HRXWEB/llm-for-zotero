import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

export type ActionDomain =
  | "zotero_library"
  | "filesystem"
  | "local_execution"
  | "network"
  | "privileged_zotero";

export type ActionEffect =
  | "read"
  | "create"
  | "modify"
  | "delete"
  | "execute"
  | "egress";

export type ActionRiskSignal =
  | "ambiguous_target"
  | "scope_expansion"
  | "sensitive_egress"
  | "broad_delete"
  | "protected_target"
  | "privilege_escalation"
  | "download_to_shell"
  | "authorization_tampering"
  | "raw_database";

export type ActionProposal = {
  version: 1;
  runtime: "original" | "claude" | "codex";
  toolName: string;
  operation: string;
  domains: ActionDomain[];
  effects: ActionEffect[];
  targets: string[];
  summary: string;
  reversibility: "full" | "partial" | "none";
  riskSignals: ActionRiskSignal[];
  intentBinding: {
    conversationKey?: number;
    conversationGeneration?: number;
    actionContractId?: string;
    userIntentDigest?: string;
  };
  payloadDigest: string;
};

export type AuthorizationDecision =
  | { kind: "execute"; authority: "safe_read" | "auto_policy" | "yolo" }
  | { kind: "confirm"; reason: string }
  | { kind: "block"; reason: string };

export type OriginalAuthorizationContext = {
  mode: OriginalAgentPermissionMode;
  userText: string;
  hasExplicitNoWrite: boolean;
};
