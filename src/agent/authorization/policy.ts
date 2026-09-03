import type {
  ActionConstraint,
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionProposal,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

const PROHIBITION = String.raw`(?:do\s+not|don't|dont|never|must\s+not|no)`;
const LIBRARY_MUTATION = new RegExp(
  String.raw`\b${PROHIBITION}\b[^.!?\n]{0,80}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\b[^.!?\n]{0,60}\b(?:library|zotero|items?|papers?|notes?|collections?|tags?|metadata)\b|\b${PROHIBITION}\b[^.!?\n]{0,40}\b(?:library|zotero|items?|papers?|notes?|collections?|tags?|metadata)\b[^.!?\n]{0,60}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\b`,
  "i",
);
const GENERIC_MUTATION = new RegExp(
  String.raw`\b${PROHIBITION}\b[^.!?\n]{0,30}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\s+(?:anything|files?|data|state)\b`,
  "i",
);
const EXECUTION = new RegExp(
  String.raw`\b${PROHIBITION}\b[^.!?\n]{0,30}\b(?:run|execute|launch)\b(?:[^.!?\n]{0,30}\b(?:commands?|scripts?|programs?|tests?|builds?)\b)?`,
  "i",
);
const EGRESS = new RegExp(
  String.raw`\b${PROHIBITION}\b[^.!?\n]{0,50}\b(?:upload|share|send|transmit|post|publish|network(?:\s+requests?)?|external\s+requests?|egress)\b`,
  "i",
);

function constraint(
  effects: ActionEffect[],
  domains: ActionDomain[],
  description: string,
): ActionConstraint {
  return { kind: "deny_effects", effects, domains, description };
}

function mechanismConstraint(
  mechanisms: Exclude<ActionMechanism, "none">[],
  description: string,
): ActionConstraint {
  return { kind: "deny_mechanisms", mechanisms, description };
}

export function parseActionConstraints(userText: string): ActionConstraint[] {
  const constraints: ActionConstraint[] = [];
  if (LIBRARY_MUTATION.test(userText)) {
    constraints.push(
      constraint(
        ["create", "modify", "delete"],
        ["zotero_library", "privileged_zotero"],
        "The user prohibited mutations to the Zotero library.",
      ),
    );
  } else if (GENERIC_MUTATION.test(userText)) {
    constraints.push(
      constraint(
        ["create", "modify", "delete"],
        ["zotero_library", "privileged_zotero", "filesystem"],
        "The user prohibited persistent state changes.",
      ),
    );
  }
  if (EXECUTION.test(userText)) {
    constraints.push(
      mechanismConstraint(
        ["shell", "zotero_script"],
        "The user prohibited commands and scripts from executing.",
      ),
    );
  }
  if (EGRESS.test(userText)) {
    constraints.push(
      constraint(
        ["egress"],
        ["network"],
        "The user prohibited external network egress.",
      ),
    );
  }
  return constraints;
}

export function hasExplicitNoWriteConstraint(userText: string): boolean {
  return parseActionConstraints(userText).some(
    (entry) =>
      entry.kind === "deny_effects" &&
      entry.effects.some((effect) =>
        ["create", "modify", "delete"].includes(effect),
      ),
  );
}

export function proposalViolatesConstraints(
  proposal: Pick<ActionProposal, "domains" | "effects" | "invocationPlan">,
  constraints: readonly ActionConstraint[],
): ActionConstraint | null {
  return (
    constraints.find((constraint) => {
      if (constraint.kind === "deny_mechanisms") {
        return (
          proposal.invocationPlan.mechanism !== "none" &&
          constraint.mechanisms.includes(proposal.invocationPlan.mechanism)
        );
      }
      return (
        proposal.domains.some((domain) =>
          constraint.domains.includes(domain),
        ) &&
        proposal.effects.some((effect) => constraint.effects.includes(effect))
      );
    }) || null
  );
}

export function normalizeStoredActionConstraints(
  constraints:
    | readonly (ActionConstraint | { kind: "no_write"; description: string })[]
    | undefined,
): ActionConstraint[] {
  return (constraints || []).flatMap((entry) => {
    if (entry.kind === "deny_mechanisms") return [entry];
    if (entry.kind === "deny_effects") {
      const executeDenied = entry.effects.includes("execute");
      const effects = entry.effects.filter((effect) => effect !== "execute");
      return [
        ...(effects.length ? [{ ...entry, effects }] : []),
        ...(executeDenied
          ? [mechanismConstraint(["shell", "zotero_script"], entry.description)]
          : []),
      ];
    }
    return [
      constraint(
        ["create", "modify", "delete"],
        [
          "zotero_library",
          "filesystem",
          "local_execution",
          "privileged_zotero",
        ],
        entry.description,
      ),
      mechanismConstraint(["shell", "zotero_script"], entry.description),
    ];
  });
}

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationDecision {
  const legacyConstraints =
    context.hasExplicitNoWrite && !context.constraints?.length
      ? [
          constraint(
            ["create", "modify", "delete"],
            [
              "zotero_library",
              "filesystem",
              "local_execution",
              "privileged_zotero",
            ],
            "The user's request explicitly prohibits changing or executing anything.",
          ),
        ]
      : [];
  const violation = proposalViolatesConstraints(proposal, [
    ...(context.constraints || []),
    ...legacyConstraints,
  ]);
  if (violation) {
    return {
      kind: "block",
      reason: violation.description,
    };
  }
  if (
    proposal.invocationPlan.impact === "prohibited" ||
    proposal.riskSignals.includes("protected_target") ||
    proposal.riskSignals.includes("raw_database") ||
    proposal.riskSignals.includes("authorization_tampering")
  ) {
    return {
      kind: "block",
      reason: "The proposed action targets a protected integrity boundary.",
    };
  }
  const trustedRead =
    proposal.invocationPlan.impact === "read_only" &&
    proposal.invocationPlan.assurance !== "unknown";
  if (trustedRead) {
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
  const exceptionalDanger = proposal.riskSignals.some((signal) =>
    [
      "ambiguous_target",
      "scope_expansion",
      "sensitive_egress",
      "broad_delete",
      "privilege_escalation",
      "package_system_modification",
      "download_to_shell",
    ].includes(signal),
  );
  if (exceptionalDanger) {
    return {
      kind: "confirm",
      reason:
        "Auto mode found genuine ambiguity or exceptional danger in the exact action.",
    };
  }
  if (proposal.invocationPlan.impact === "ambiguous") {
    return { kind: "execute", authority: "auto_policy" };
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
  return { kind: "execute", authority: "auto_policy" };
}
