import type { AgentLibraryWriteMode } from "./agentLibraryWriteMode";
import type { ClaudePermissionMode } from "./claudePermissionMode";

export type PermissionProvider = "original" | "claude" | "codex";

export type PermissionRisk =
  | "restricted"
  | "standard"
  | "elevated"
  | "full-access"
  | "custom";

export type PermissionOption = {
  provider: PermissionProvider;
  id: string;
  fullLabel: string;
  compactLabel: string;
  levelLabel: string;
  description: string;
  risk: PermissionRisk;
  available: boolean;
  disabledReason?: string;
};

export type CodexPermissionProfile = {
  id: string;
  description: string;
  allowed: boolean;
  disabledReason?: string;
};

const ORIGINAL_OPTIONS: Record<AgentLibraryWriteMode, PermissionOption> = {
  safe: {
    provider: "original",
    id: "safe",
    fullLabel: "Safe",
    compactLabel: "safe",
    levelLabel: "Restricted",
    description: "Review every Zotero library change before it happens.",
    risk: "restricted",
    available: true,
  },
  auto: {
    provider: "original",
    id: "auto",
    fullLabel: "Auto",
    compactLabel: "auto",
    levelLabel: "Standard",
    description:
      "Apply reversible library changes and ask before irreversible changes.",
    risk: "standard",
    available: true,
  },
  yolo: {
    provider: "original",
    id: "yolo",
    fullLabel: "Yolo",
    compactLabel: "yolo",
    levelLabel: "Full access",
    description:
      "Let the Original Agent apply library changes on its own judgement.",
    risk: "full-access",
    available: true,
  },
};

const CLAUDE_PRESENTATION: Record<
  ClaudePermissionMode,
  Omit<PermissionOption, "provider" | "id" | "available">
> = {
  plan: {
    fullLabel: "Plan",
    compactLabel: "plan",
    levelLabel: "Restricted",
    description: "Plan without executing tools that modify the environment.",
    risk: "restricted",
  },
  dontAsk: {
    fullLabel: "Don’t ask",
    compactLabel: "no prompts",
    levelLabel: "Restricted",
    description: "Decline permission prompts instead of asking the user.",
    risk: "restricted",
  },
  default: {
    fullLabel: "Default",
    compactLabel: "default",
    levelLabel: "Standard",
    description: "Use Claude Code's standard permission behavior.",
    risk: "standard",
  },
  acceptEdits: {
    fullLabel: "Accept edits",
    compactLabel: "edits",
    levelLabel: "Elevated",
    description:
      "Automatically accept file edits while retaining other prompts.",
    risk: "elevated",
  },
  auto: {
    fullLabel: "Auto approval",
    compactLabel: "auto",
    levelLabel: "Elevated",
    description: "Let Claude Code automatically resolve supported permissions.",
    risk: "elevated",
  },
  bypassPermissions: {
    fullLabel: "Bypass permissions",
    compactLabel: "bypass",
    levelLabel: "Full access",
    description: "Bypass Claude Code permission checks for this runtime.",
    risk: "full-access",
  },
};

const CODEX_PRESENTATION: Record<
  string,
  Omit<PermissionOption, "provider" | "id" | "description" | "available">
> = {
  ":read-only": {
    fullLabel: "Read only",
    compactLabel: "read only",
    levelLabel: "Restricted",
    risk: "restricted",
  },
  ":workspace": {
    fullLabel: "Workspace access",
    compactLabel: "workspace",
    levelLabel: "Elevated",
    risk: "elevated",
  },
  ":danger-full-access": {
    fullLabel: "Danger full access",
    compactLabel: "full access",
    levelLabel: "Full access",
    risk: "full-access",
  },
};

export function getOriginalPermissionOptions(): PermissionOption[] {
  return ["safe", "auto", "yolo"].map(
    (id) => ORIGINAL_OPTIONS[id as AgentLibraryWriteMode],
  );
}

export function buildClaudePermissionOption(params: {
  id: ClaudePermissionMode;
  available?: boolean;
  description?: string;
  disabledReason?: string;
}): PermissionOption {
  const presentation = CLAUDE_PRESENTATION[params.id];
  return {
    provider: "claude",
    id: params.id,
    ...presentation,
    description: params.description?.trim() || presentation.description,
    available: params.available !== false,
    disabledReason: params.disabledReason,
  };
}

export function normalizeCodexProfileLabel(id: string): string {
  const normalized = id.replace(/^:/, "").replace(/[-_]+/g, " ").trim();
  return normalized || id;
}

export function buildCodexPermissionOption(
  profile: CodexPermissionProfile,
): PermissionOption {
  const presentation = CODEX_PRESENTATION[profile.id];
  const fullLabel =
    presentation?.fullLabel || normalizeCodexProfileLabel(profile.id);
  return {
    provider: "codex",
    id: profile.id,
    fullLabel,
    compactLabel: presentation?.compactLabel || fullLabel,
    levelLabel: presentation?.levelLabel || "Custom",
    description: profile.description,
    risk: presentation?.risk || "custom",
    available: profile.allowed,
    disabledReason: profile.disabledReason,
  };
}

export function buildPermissionAccessibleLabel(
  option: PermissionOption,
): string {
  const provider =
    option.provider === "claude"
      ? "Claude Code"
      : option.provider === "codex"
        ? "Codex"
        : "Original Agent";
  const description = option.description.trim();
  return `${provider} permission mode: ${option.id} — ${option.levelLabel}${description ? ` — ${description}` : ""}`;
}
