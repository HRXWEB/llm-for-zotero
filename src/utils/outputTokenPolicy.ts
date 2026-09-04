import {
  getModelCapabilities,
  type ModelProfileOverride,
} from "../modelCapabilities";
import type { OutputTokenLimitSetting } from "../shared/types";
import { MAX_ALLOWED_TOKENS } from "./llmDefaults";
import type { ModelProviderAuthMode } from "./modelProviders";
import { detectProviderPreset } from "./providerPresets";
import type { ProviderProtocol } from "./providerProtocol";

/** Expected answer space reserved by prompt planners; never a wire-level cap. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

/**
 * Anthropic-compatible Messages endpoints require max_tokens. Unknown models
 * use this conservative seed until capability metadata is available.
 */
export const AUTO_REQUIRED_OUTPUT_TOKEN_SEED = 8_192;

export type OutputRequestPolicy =
  | {
      mode: "omit";
      source: "auto_provider";
    }
  | {
      mode: "runtime_managed";
      source: "runtime";
    }
  | {
      mode: "unlimited";
      source: "auto_provider";
    }
  | {
      mode: "numeric";
      tokens: number;
      source: "auto_capability" | "auto_compatibility" | "custom";
    };

type OutputPolicyIdentity = {
  setting?: OutputTokenLimitSetting;
  model: string;
  apiBase?: string;
  protocol: ProviderProtocol;
  authMode?: ModelProviderAuthMode;
  profileOverride?: ModelProfileOverride;
};

function resolveKnownOutputLimit(
  params: Omit<OutputPolicyIdentity, "setting">,
): number | undefined {
  const capabilities = getModelCapabilities({
    model: params.model,
    provider: params.apiBase
      ? detectProviderPreset(params.apiBase).toString()
      : undefined,
    apiBase: params.apiBase,
    protocol: params.protocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  const limit = capabilities.limits.outputTokens;
  return Number.isSafeInteger(limit) && Number(limit) > 0
    ? Math.min(Number(limit), MAX_ALLOWED_TOKENS)
    : undefined;
}

function normalizeCustomTokens(value: unknown, knownLimit?: number): number {
  const parsed = Math.floor(Number(value));
  const normalized =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.min(parsed, MAX_ALLOWED_TOKENS)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return knownLimit ? Math.min(normalized, knownLimit) : normalized;
}

export function resolveOutputRequestPolicy(
  params: OutputPolicyIdentity,
): OutputRequestPolicy {
  if (
    params.authMode === "codex_auth" ||
    params.authMode === "codex_app_server" ||
    params.authMode === "webchat" ||
    params.protocol === "web_sync"
  ) {
    return { mode: "runtime_managed", source: "runtime" };
  }

  const setting = params.setting || { mode: "auto" };
  const identity = {
    model: params.model,
    apiBase: params.apiBase,
    protocol: params.protocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  };
  const knownLimit = resolveKnownOutputLimit(identity);

  if (setting.mode === "custom") {
    return {
      mode: "numeric",
      tokens: normalizeCustomTokens(setting.tokens, knownLimit),
      source: "custom",
    };
  }

  if (params.protocol === "ollama_native") {
    return { mode: "unlimited", source: "auto_provider" };
  }
  if (params.protocol === "anthropic_messages") {
    return knownLimit
      ? {
          mode: "numeric",
          tokens: knownLimit,
          source: "auto_capability",
        }
      : {
          mode: "numeric",
          tokens: AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
          source: "auto_compatibility",
        };
  }
  return { mode: "omit", source: "auto_provider" };
}

export function resolveOutputReserve(
  setting: OutputTokenLimitSetting | undefined,
  model: string,
  identity?: Omit<OutputPolicyIdentity, "setting" | "model" | "protocol"> & {
    protocol?: ProviderProtocol;
  },
): number {
  const knownLimit = identity?.protocol
    ? resolveKnownOutputLimit({
        model,
        apiBase: identity.apiBase,
        protocol: identity.protocol,
        authMode: identity.authMode,
        profileOverride: identity.profileOverride,
      })
    : getModelCapabilities({ model }).limits.outputTokens;
  const requested =
    setting?.mode === "custom"
      ? normalizeCustomTokens(setting.tokens)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return knownLimit ? Math.min(requested, knownLimit) : requested;
}
