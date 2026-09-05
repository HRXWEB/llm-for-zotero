/**
 * Permission mode for the in-plugin Original Agent.
 *
 * Unlike the legacy library-write preference, this mode governs every
 * Original Agent capability: Zotero mutations, local files, commands,
 * privileged scripts, and agent-controlled network access.
 * Claude Code and Codex retain their own independent native profiles.
 */
export type OriginalAgentPermissionMode = "auto" | "safe" | "yolo";

export function normalizeOriginalAgentPermissionMode(
  value: unknown,
): OriginalAgentPermissionMode {
  if (value === "yolo") return "yolo";
  if (value === "safe") return "safe";
  return "auto";
}

export function getOriginalAgentPermissionModeDescription(): string {
  return "Explicitly requested new Zotero notes are created without confirmation and shown as saved-note cards in every mode. auto executes clear, in-scope actions and asks only for genuine ambiguity or exceptional danger. safe reviews other writes, filesystem reads outside the current context, commands, scripts, and network actions. yolo executes every valid in-scope action without mode-based prompts. Hard scope, lifecycle, journal, and integrity checks remain active in every mode.";
}
