import type { AgentRuntimeRequest } from "../types";
import {
  DEFAULT_MAX_TOKENS,
  MAX_ALLOWED_TOKENS,
} from "../../utils/llmDefaults";
import { normalizeMaxTokensForRequest } from "../../utils/llmClient";
import { getModelOutputTokenLimit } from "../../utils/normalization";
import { detectProviderPreset } from "../../utils/providerPresets";
import type { ProviderProtocol } from "../../utils/providerProtocol";

/**
 * The agent is designed to handle multi-step workflows (chained searches,
 * search-then-import-then-move, etc.) so we give it generous limits by
 * default.  Bulk operations that touch many items still get a higher cap.
 */
export const MAX_AGENT_ROUNDS = 24;
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 8;

export const MAX_BULK_AGENT_ROUNDS = 32;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 10;

/**
 * Resolve the output envelope for a structured agent step.
 *
 * The shared 8192-token default predates thinking models whose hidden
 * reasoning consumes the same provider completion budget as their tool call.
 * When that value is untouched and thinking is enabled, use the model's
 * declared output capability instead of turning the UI default into a hard
 * stop. An explicit user value remains authoritative, disabled/minimal
 * thinking keeps the ordinary default, and an unknown capability never
 * expands to the registry's corruption ceiling.
 */
export function resolveAgentOutputTokenBudget(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
): number {
  const configured = normalizeMaxTokensForRequest({
    value: request.advanced?.maxTokens,
    maxTokensExplicit: request.advanced?.maxTokensExplicit,
    model: request.model || "",
    apiBase: request.apiBase,
    protocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  });
  const reasoningLevel = request.reasoning?.level?.trim().toLowerCase();
  if (
    request.advanced?.maxTokensExplicit === true ||
    configured !== DEFAULT_MAX_TOKENS ||
    !reasoningLevel ||
    reasoningLevel === "minimal" ||
    reasoningLevel === "none"
  ) {
    return configured;
  }
  const declaredLimit = getModelOutputTokenLimit(request.model || "", {
    provider: request.apiBase
      ? detectProviderPreset(request.apiBase).toString()
      : undefined,
    apiBase: request.apiBase,
    protocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  });
  return declaredLimit < MAX_ALLOWED_TOKENS ? declaredLimit : configured;
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
