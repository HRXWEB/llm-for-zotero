import type {
  ActionProposal,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

const EXPLICIT_NO_WRITE =
  /\b(?:do\s+not|don't|dont|never|must\s+not)\s+(?:change|modify|edit|write|delete|remove|run|execute|create|save|update|mutate)\b/i;

export function hasExplicitNoWriteConstraint(userText: string): boolean {
  return EXPLICIT_NO_WRITE.test(userText);
}

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationDecision {
  const changesState = proposal.effects.some((effect) =>
    ["create", "modify", "delete", "execute", "egress"].includes(effect),
  );
  if (context.hasExplicitNoWrite && changesState) {
    return {
      kind: "block",
      reason:
        "The user's request explicitly prohibits changing or executing anything.",
    };
  }
  if (
    proposal.riskSignals.includes("protected_target") ||
    proposal.riskSignals.includes("raw_database") ||
    proposal.riskSignals.includes("authorization_tampering")
  ) {
    return {
      kind: "block",
      reason: "The proposed action targets a protected integrity boundary.",
    };
  }
  const trustedLibraryRead =
    proposal.domains.length === 1 &&
    proposal.domains[0] === "zotero_library" &&
    proposal.effects.every((effect) => effect === "read");
  if (trustedLibraryRead) {
    return { kind: "execute", authority: "safe_read" };
  }
  if (context.mode === "safe") {
    return {
      kind: "confirm",
      reason: "Safe mode reviews this action before it runs.",
    };
  }
  if (context.mode === "yolo") {
    return { kind: "execute", authority: "yolo" };
  }
  const intentPattern = proposal.domains.includes("local_execution")
    ? /\b(?:run|execute|command|shell|terminal|script|test|build|install|analy[sz]e|compute|calculate|convert)\b/i
    : proposal.domains.includes("privileged_zotero")
      ? /\b(?:run|execute|script|analy[sz]e|compute|calculate|change|modify|edit|update|write|delete|create)\b/i
      : proposal.domains.includes("filesystem")
        ? /\b(?:read|open|inspect|write|save|create|edit|change|modify|delete|remove|move|copy|file|folder|directory)\b/i
        : proposal.domains.includes("network")
          ? /\b(?:search|research|investigate|find|look\s+up|browse|web|online|current|latest|news|fact|fetch|download|upload|request|url|page)\b/i
          : /\b(?:add|apply|change|create|delete|edit|file|import|merge|modify|move|remove|rename|restore|save|set|tag|trash|update|write|fix)\b/i;
  if (!intentPattern.test(context.userText)) {
    return {
      kind: "confirm",
      reason:
        "Auto mode could not map the proposed effect to a clear action in the user's request.",
    };
  }
  const exceptionalDanger = proposal.riskSignals.some((signal) =>
    [
      "ambiguous_target",
      "scope_expansion",
      "sensitive_egress",
      "broad_delete",
      "privilege_escalation",
      "download_to_shell",
    ].includes(signal),
  );
  return exceptionalDanger
    ? {
        kind: "confirm",
        reason:
          "Auto mode found genuine ambiguity or exceptional danger in the exact action.",
      }
    : { kind: "execute", authority: "auto_policy" };
}
