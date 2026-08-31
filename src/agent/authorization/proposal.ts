import type { AgentMutationPlan, AgentToolDefinition } from "../types";
import type {
  ActionDomain,
  ActionEffect,
  ActionProposal,
  ActionRiskSignal,
} from "./types";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function inferDomain(toolName: string): ActionDomain[] {
  if (toolName === "file_io") return ["filesystem"];
  if (toolName === "run_command") {
    return ["local_execution", "filesystem", "network"];
  }
  if (toolName === "zotero_script") return ["privileged_zotero"];
  if (toolName === "web_search" || toolName === "web_read") {
    return ["network"];
  }
  return ["zotero_library"];
}

function inferEffects(
  toolName: string,
  input: unknown,
  plan: AgentMutationPlan,
): ActionEffect[] {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (toolName === "run_command") return ["execute"];
  if (toolName === "zotero_script") {
    return record.effect === "write" || record.mode === "write"
      ? ["execute", "modify"]
      : ["execute", "read"];
  }
  if (toolName === "file_io") {
    return record.action === "read"
      ? ["read"]
      : record.action === "delete"
        ? ["delete"]
        : ["modify"];
  }
  if (toolName === "web_search" || toolName === "web_read") {
    return ["read", "egress"];
  }
  return plan.effect === "write" ? ["modify"] : ["read"];
}

function collectTargets(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const values = [
    record.filePath,
    record.path,
    record.cwd,
    record.url,
    record.query,
    record.command,
    record.itemId,
    record.itemID,
    record.itemIds,
    record.itemIDs,
    record.collectionId,
    record.collectionID,
  ];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
    .map(String)
    .filter(Boolean)
    .slice(0, 1000);
}

function inferRiskSignals(
  toolName: string,
  input: unknown,
): ActionRiskSignal[] {
  const serialized = JSON.stringify(input || {});
  const signals = new Set<ActionRiskSignal>();
  if (
    /\b(?:rm|rmdir)\s+(?:-[^\s]+\s+)*(?:\/|~|\$HOME)(?=[\s"']|$)/i.test(
      serialized,
    )
  ) {
    signals.add("protected_target");
  }
  if (/\b(?:rm|rmdir)\b[^\n]*(?:-r|-rf|-fr)\b/i.test(serialized)) {
    signals.add("broad_delete");
  }
  if (/\b(?:sudo|doas|runas)\b/i.test(serialized)) {
    signals.add("privilege_escalation");
  }
  if (/(?:curl|wget)[\s\S]*\|\s*(?:sh|bash|zsh)/i.test(serialized)) {
    signals.add("download_to_shell");
  }
  if (/\bZotero\.DB\b|\braw\s+sql\b/i.test(serialized)) {
    signals.add("raw_database");
  }
  if (
    /originalAgentPermissionMode|agentLibraryWriteMode|authorization|grantStore/i.test(
      serialized,
    )
  ) {
    signals.add("authorization_tampering");
  }
  if (toolName === "run_command" && !collectTargets(input).length) {
    signals.add("ambiguous_target");
  }
  return [...signals];
}

export function buildActionProposal(params: {
  tool: AgentToolDefinition<any, any>;
  input: unknown;
  plan: AgentMutationPlan;
  intentBinding?: {
    conversationKey?: number;
    conversationGeneration?: number;
    actionContractId?: string;
    userText?: string;
  };
}): ActionProposal {
  const domains = inferDomain(params.tool.spec.name);
  const effects = inferEffects(
    params.tool.spec.name,
    params.input,
    params.plan,
  );
  const targets = collectTargets(params.input);
  const intentBinding = {
    conversationKey: params.intentBinding?.conversationKey,
    conversationGeneration: params.intentBinding?.conversationGeneration,
    actionContractId: params.intentBinding?.actionContractId,
    userIntentDigest: params.intentBinding?.userText
      ? hashText(params.intentBinding.userText)
      : undefined,
  };
  const canonical = JSON.stringify(
    stableValue({
      toolName: params.tool.spec.name,
      input: params.input,
      domains,
      effects,
      intentBinding,
    }),
  );
  return {
    version: 1,
    runtime: "original",
    toolName: params.tool.spec.name,
    operation: `${params.tool.spec.name}:${effects.join("+")}`,
    domains,
    effects,
    targets,
    summary: `${params.tool.spec.name} ${effects.join(", ")}`,
    reversibility: params.plan.reversibility,
    riskSignals: inferRiskSignals(params.tool.spec.name, params.input),
    intentBinding,
    payloadDigest: hashText(canonical),
  };
}
