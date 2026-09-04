import type { AgentRuntimeRequest } from "../types";
import {
  resolveOutputRequestPolicy,
  type OutputRequestPolicy,
} from "../../utils/outputTokenPolicy";
import type { ProviderProtocol } from "../../utils/providerProtocol";

/** Whole-run boundaries; independent of any one response's output policy. */
export const MAX_AGENT_ROUNDS = 24;
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 8;

export const MAX_BULK_AGENT_ROUNDS = 32;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 10;

/**
 * Resolve one Agent inference's wire policy. Whole-run limits remain owned by
 * the runtime's rounds, progress checks, checkpoints, and context compaction.
 */
export function resolveAgentOutputRequestPolicy(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
): OutputRequestPolicy {
  const policy = resolveOutputRequestPolicy({
    setting: request.advanced?.outputTokenLimit,
    model: request.model || "",
    apiBase: request.apiBase,
    protocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  });
  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.("LLM Agent: Resolved output policy", {
    settingMode: request.advanced?.outputTokenLimit?.mode || "auto",
    resolutionSource: policy.source,
    transmittedPolicy:
      policy.mode === "numeric"
        ? { mode: "numeric", tokens: policy.tokens }
        : { mode: policy.mode },
    protocol,
  });
  return policy;
}

export function resolveAgentLimits(isBulkOperation: boolean): {
  maxRounds: number;
  maxToolCallsPerRound: number;
} {
  if (isBulkOperation) {
    return {
      maxRounds: MAX_BULK_AGENT_ROUNDS,
      maxToolCallsPerRound: MAX_BULK_TOOL_CALLS_PER_ROUND,
    };
  }
  return {
    maxRounds: MAX_AGENT_ROUNDS,
    maxToolCallsPerRound: MAX_AGENT_TOOL_CALLS_PER_ROUND,
  };
}
