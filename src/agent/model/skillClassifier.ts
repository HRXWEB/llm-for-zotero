/**
 * Skill intent classifier — runs ONCE per user turn.
 *
 * Architecture note: when the user sends a message, this module is called
 * exactly once (before the agent loop starts) to decide which skills apply.
 * The returned skill IDs flow into current-turn guidance, and that guidance is
 * reused across every model inference the agent performs to fulfil the request.
 * There is no per-model-call classifier cost.
 *
 * The classifier uses the user's configured primary model (via
 * `request.model` / `request.apiBase` / `request.apiKey`) and a small
 * structured prompt listing only context-eligible skill manifests. On any
 * error, automatic skill activation fails closed.
 */
import {
  callUtilityLLM,
  logUtilityLLMFailure,
  type UtilityLLMFailureReason,
  type UtilityLLMParams,
} from "../../utils/utilityLLM";
import {
  isSkillContextEligible,
  resolveSkillRequestContext,
} from "../skills/contextEligibility";
import type { AgentSkill } from "../skills/skillLoader";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import {
  SKILL_ROUTER_PROMPT_VERSION,
  SKILL_ROUTER_ADAPTER_PROTOCOL_VERSION,
  SKILL_ROUTER_SCHEMA_VERSION,
  type SkillRequestedScope,
  type SkillRouterResponseV1,
  type SkillRouterSelection,
  type SkillRoutingReceipt,
  type PlanSkillRoutingReceipt,
  type ValidatedSkillActivation,
} from "../skills/routingTypes";
import type { AgentRuntimeRequest, ClassifiedTurnIntent } from "../types";
import {
  inferActionIntentsFromRequest,
  parseActionIntents,
} from "./actionIntent";
export { inferActionIntentsFromRequest } from "./actionIntent";

/**
 * Pseudo-skill ID the classifier can return when none of the real skills
 * apply. Giving the LLM an explicit "no-match" label to commit to works
 * better than asking it to return an empty array — empty arrays read as
 * uncertainty and bias the LLM toward populating them with weak matches.
 * Translated back to `[]` by `parseClassifierResponse`.
 */
const UNMATCHED_ID = "unmatched";
const ROUTER_CACHE_MAX_ENTRIES = 200;
const routerCache = new Map<
  string,
  { response: SkillRouterResponseV1; activations: ValidatedSkillActivation[] }
>();

// Generous enough for reasoning providers whose hidden thinking regularly
// exceeds 10s to completion; the runtime abort signal still cancels early.
export const TURN_INTENT_TIMEOUT_MS = 20_000;

export type DetectTurnIntentResult = {
  skillIds: string[];
  /** Null whenever classification degraded; callers retain deterministic safety. */
  classifiedIntent: ClassifiedTurnIntent | null;
  /**
   * True when a usable model config was present but the LLM call failed or
   * returned malformed output — the silent-regression case worth surfacing.
   */
  degraded: boolean;
  /** Detailed reason for a degraded or skipped classifier attempt. */
  failureReason?: UtilityLLMFailureReason | "unparseable";
  routingReceipt?: SkillRoutingReceipt;
};

/**
 * Classify skills and language-independent read intent in one bounded LLM
 * call, with a second exact action call only for possible mutations. Never
 * throws — any router failure activates no automatic skills.
 */
export async function detectTurnIntent(
  request: AgentRuntimeRequest,
  skills: AgentSkill[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    llmCall?: UtilityLLMParams["llmCall"];
  } = {},
): Promise<DetectTurnIntentResult> {
  if (skills.length === 0) {
    return { skillIds: [], classifiedIntent: null, degraded: false };
  }
  const userText = (request.userText || "").trim();
  if (!userText) {
    const explicit = await buildExplicitActivations(request, skills);
    return {
      skillIds: explicit.map((activation) => activation.id),
      classifiedIntent: null,
      degraded: false,
      ...(explicit.length
        ? {
            routingReceipt: {
              routerSchemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
              routerIdentityHash: await buildRouterCacheIdentity(request, []),
              skillManifestHash: await hashSkillManifest(skills),
              skills: explicit,
            },
          }
        : {}),
    };
  }
  if (!canUseSkillClassifierModel(request)) {
    const explicit = await buildExplicitActivations(request, skills);
    return {
      skillIds: explicit.map((activation) => activation.id),
      classifiedIntent: null,
      degraded: false,
      failureReason: "not_configured",
      ...(explicit.length
        ? {
            routingReceipt: {
              routerSchemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
              routerIdentityHash: await buildRouterCacheIdentity(request, []),
              skillManifestHash: await hashSkillManifest(skills),
              skills: explicit,
            },
          }
        : {}),
    };
  }

  const eligibleSkills = skills.filter(
    (skill) =>
      skill.activation !== "manual" && isSkillContextEligible(skill, request),
  );
  const cacheIdentity = await buildRouterCacheIdentity(request, eligibleSkills);
  const cached = routerCache.get(cacheIdentity);
  let routerResponse: SkillRouterResponseV1;
  let automaticActivations: ValidatedSkillActivation[];
  if (cached) {
    routerResponse = cached.response;
    automaticActivations = cached.activations;
  } else {
    const prompt = buildClassifierPrompt(eligibleSkills, request);

    const result = await callUtilityLLM({
      prompt,
      model: request.model,
      apiBase: request.apiBase,
      apiKey: request.apiKey,
      authMode: request.authMode,
      providerProtocol: request.providerProtocol,
      profileOverride: request.advanced?.profileOverride,
      jsonBudget: 500,
      temperature: 0,
      signal: options.signal,
      timeoutMs: options.timeoutMs || TURN_INTENT_TIMEOUT_MS,
      llmCall: options.llmCall,
    });
    if (!result.ok) {
      logUtilityLLMFailure(
        "Skill router LLM call failed; activating no automatic skills",
        result,
      );
      return {
        skillIds: [],
        classifiedIntent: null,
        degraded: true,
        failureReason: result.reason,
      };
    }
    const parsedRouter = parseSkillRouterResponse(result.text);
    if (!parsedRouter) {
      return {
        skillIds: [],
        classifiedIntent: null,
        degraded: true,
        failureReason: "unparseable",
      };
    }
    routerResponse = parsedRouter;
    automaticActivations = await validateSkillRouterSelections({
      response: parsedRouter,
      request,
      skills: eligibleSkills,
    });
    if (automaticActivations.length === parsedRouter.selections.length) {
      routerCache.set(cacheIdentity, {
        response: parsedRouter,
        activations: automaticActivations,
      });
      while (routerCache.size > ROUTER_CACHE_MAX_ENTRIES) {
        const oldest = routerCache.keys().next().value;
        if (typeof oldest !== "string") break;
        routerCache.delete(oldest);
      }
    }
  }

  const deterministicActions = inferActionIntentsFromRequest(request);
  let actionIntents = deterministicActions;
  let actionInterpretationSource: ClassifiedTurnIntent["actionInterpretationSource"] =
    deterministicActions.length ? "deterministic_fallback" : "classifier";
  if (
    routerResponse.taskKind !== "read" ||
    deterministicActions.some((action) => action.operation !== "read_full")
  ) {
    const actionResult = await classifyActionIntent(
      request,
      routerResponse,
      options,
    );
    if (actionResult) {
      actionIntents = actionResult;
      actionInterpretationSource = "classifier";
    }
  }
  const classifiedIntent: ClassifiedTurnIntent = {
    retrievalIntent: routerResponse.retrievalIntent,
    deliverableIntent: routerResponse.deliverableIntent,
    documentKind: routerResponse.documentKind,
    paperTargetIntent: routerResponse.paperTargetIntent,
    externalSearchIntent: routerResponse.externalSearchIntent,
    wantedSections: [...routerResponse.wantedSections],
    queryLanguage: routerResponse.queryLanguage,
    writeDisposition: actionIntents.some(
      (action) => action.operation !== "read_full",
    )
      ? "required"
      : "none",
    actionInterpretationSource,
    actionIntents,
  };
  const explicitActivations = await buildExplicitActivations(request, skills);
  const activations = reduceValidatedActivations(
    [...explicitActivations, ...automaticActivations],
    skills,
  );
  const skillManifestHash = await hashSkillManifest(skills);
  return {
    skillIds: activations.map((activation) => activation.id),
    classifiedIntent,
    degraded: false,
    routingReceipt: {
      routerSchemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
      routerIdentityHash: cacheIdentity,
      skillManifestHash,
      skills: activations,
    },
  };
}

/**
 * Classify which skills apply to the given request.
 *
 * Returns a list of validated skill IDs drawn from `skills`. Never throws.
 * Thin wrapper kept for consumers that
 * only need skill routing (e.g. the Codex native-skills path).
 */
export async function detectSkillIntent(
  request: AgentRuntimeRequest,
  skills: AgentSkill[],
  signal?: AbortSignal,
): Promise<string[]> {
  return (await detectTurnIntent(request, skills, { signal })).skillIds;
}

export function canUseSkillClassifierModel(
  request: Pick<AgentRuntimeRequest, "model" | "apiBase" | "authMode">,
): boolean {
  if (!request.model) return false;
  if (request.authMode === "codex_app_server") return false;
  if (request.apiBase) return true;
  return false;
}

function buildClassifierPrompt(
  skills: AgentSkill[],
  request: AgentRuntimeRequest,
): string {
  const skillList = skills
    .map(
      (skill) =>
        `- ${skill.id}: ${skill.description || "(no description)"} [contexts: ${skill.contexts.join(",")}]`,
    )
    .join("\n");

  const context: string[] = [];
  const resolvedContext = resolveSkillRequestContext(request);
  context.push(
    `- Unique papers in context: ${resolvedContext.uniquePaperCount}`,
  );
  if (resolvedContext.hasLibraryCorpus)
    context.push("- Library/corpus context: yes");
  if (request.activeNoteContext) context.push("- Active note present: yes");
  if (request.selectedTexts?.length)
    context.push(`- Selected text snippets: ${request.selectedTexts.length}`);
  if (request.screenshots?.length)
    context.push(`- Screenshots attached: ${request.screenshots.length}`);
  const fullTextPaperCount = request.turnPaperScope.papers.filter((entry) =>
    entry.roles.includes("full_text"),
  ).length;
  if (fullTextPaperCount)
    context.push(`- Full-text papers marked: ${fullTextPaperCount}`);
  if (request.turnPaperScope.collections.length) {
    context.push(
      `- Selected collection scopes: ${request.turnPaperScope.collections.length}`,
    );
  }
  if (request.turnPaperScope.tags.length) {
    context.push(
      `- Selected tag scopes: ${request.turnPaperScope.tags.length}`,
    );
  }

  return [
    `You are version ${SKILL_ROUTER_PROMPT_VERSION} of a multilingual skill and scope router for a Zotero research assistant.`,
    "",
    "Classify meaning in the user's language. Most requests need no skill.",
    "Select only skills that clearly provide a specialized playbook for a distinct requested task.",
    "For every selection, copy a short exact substring from the user message into evidenceText. Never calculate offsets and never translate or normalize the evidence.",
    "requestedScopes describe what the user asks to operate on, not every context that happens to be available.",
    'taskKind is "write" only for an actual requested mutation, "mixed" for read plus mutation, otherwise "read".',
    '• retrievalIntent: how the question should read the library, in any language — "enumerate" for which/all/list/find-evidence questions, "verify" for exact presence/absence checks, "summarize" for themes/commonalities/comparisons/overviews across papers, "none" for pure operations (tagging, moving, editing) or single-paper reads.',
    '• paperTargetIntent: which visible paper set the user references, in any language — "active" for this/current paper, "added" for selected/attached/added papers other than the active paper, "all_visible" for both/these/all papers visible in the turn, and "unspecified" only when no paper-set reference was found.',
    '• externalSearchIntent: whether the answer needs live external evidence, in any language — "web" for general public web information, "literature" for scholarly discovery or external scholarly metadata, "both" when distinct parts need each source, and "none" when the available context or stable knowledge is sufficient. The tools are complementary, not mutually exclusive.',
    "• wantedSections: only the sections the user explicitly asks about (methods, results, limitations); otherwise an empty array.",
    '• queryLanguage: short language code of the user message, e.g. "en", "zh", "ja".',
    "",
    "Available skills:",
    skillList,
    "",
    "Runtime context:",
    ...context,
    "",
    "User message:",
    `"""`,
    request.userText,
    `"""`,
    "",
    '• deliverableIntent: "document" only when the user explicitly asks Agent to write/create/draft a document, report, guide, manuscript, or literature review; "chat" for ordinary questions and summaries; "unspecified" only when genuinely ambiguous. Do not infer document intent from answer length.',
    "• documentKind: for document outcomes choose research_brief, literature_review, comparison, report, guide, or custom. Omit it for chat.",
    `Reply with ONLY JSON: {"schemaVersion":${SKILL_ROUTER_SCHEMA_VERSION},"taskKind":"read|write|mixed","queryLanguage":"en","requestedScopes":["none|single-paper|paper-set|library-corpus|note|visual-input"],"selections":[{"skillId":"id","requestedScope":"single-paper","evidenceText":"exact copied text","occurrence":0}],"retrievalIntent":"enumerate|verify|summarize|none","deliverableIntent":"chat|document|unspecified","documentKind":"research_brief|literature_review|comparison|report|guide|custom","paperTargetIntent":"active|added|all_visible|unspecified","externalSearchIntent":"none|web|literature|both","wantedSections":[]}`,
  ].join("\n");
}

const VALID_REQUESTED_SCOPES = new Set<SkillRequestedScope>([
  "none",
  "single-paper",
  "paper-set",
  "library-corpus",
  "note",
  "visual-input",
]);
const VALID_TASK_KINDS = new Set(["read", "write", "mixed"]);

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseSkillRouterResponse(
  raw: string,
): SkillRouterResponseV1 | null {
  const record = extractJsonObject(raw);
  if (!record || record.schemaVersion !== SKILL_ROUTER_SCHEMA_VERSION)
    return null;
  if (
    typeof record.taskKind !== "string" ||
    !VALID_TASK_KINDS.has(record.taskKind)
  )
    return null;
  if (
    !Array.isArray(record.requestedScopes) ||
    !Array.isArray(record.selections)
  )
    return null;
  const requestedScopes = record.requestedScopes.filter(
    (value): value is SkillRequestedScope =>
      typeof value === "string" &&
      VALID_REQUESTED_SCOPES.has(value as SkillRequestedScope),
  );
  if (requestedScopes.length !== record.requestedScopes.length) return null;
  const selections: SkillRouterSelection[] = [];
  for (const value of record.selections) {
    if (!value || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (
      typeof selection.skillId !== "string" ||
      typeof selection.requestedScope !== "string" ||
      !VALID_REQUESTED_SCOPES.has(
        selection.requestedScope as SkillRequestedScope,
      ) ||
      typeof selection.evidenceText !== "string" ||
      !selection.evidenceText
    )
      return null;
    if (
      selection.occurrence !== undefined &&
      (!Number.isInteger(selection.occurrence) ||
        Number(selection.occurrence) < 0)
    )
      return null;
    selections.push({
      skillId: selection.skillId,
      requestedScope: selection.requestedScope as SkillRequestedScope,
      evidenceText: selection.evidenceText,
      ...(selection.occurrence === undefined
        ? {}
        : { occurrence: Number(selection.occurrence) }),
    });
  }
  const retrievalIntent =
    typeof record.retrievalIntent === "string" &&
    VALID_RETRIEVAL_INTENTS.has(record.retrievalIntent)
      ? (record.retrievalIntent as SkillRouterResponseV1["retrievalIntent"])
      : null;
  if (!retrievalIntent) return null;
  const paperTargetIntent =
    typeof record.paperTargetIntent === "string" &&
    VALID_PAPER_TARGET_INTENTS.has(record.paperTargetIntent)
      ? (record.paperTargetIntent as NonNullable<
          SkillRouterResponseV1["paperTargetIntent"]
        >)
      : undefined;
  const externalSearchIntent =
    typeof record.externalSearchIntent === "string" &&
    VALID_EXTERNAL_SEARCH_INTENTS.has(record.externalSearchIntent)
      ? (record.externalSearchIntent as NonNullable<
          SkillRouterResponseV1["externalSearchIntent"]
        >)
      : undefined;
  const deliverableIntent = ["chat", "document", "unspecified"].includes(
    String(record.deliverableIntent),
  )
    ? (record.deliverableIntent as NonNullable<
        SkillRouterResponseV1["deliverableIntent"]
      >)
    : undefined;
  const documentKinds = new Set([
    "research_brief",
    "literature_review",
    "comparison",
    "report",
    "guide",
    "custom",
  ]);
  const documentKind = documentKinds.has(String(record.documentKind))
    ? (record.documentKind as NonNullable<
        SkillRouterResponseV1["documentKind"]
      >)
    : undefined;
  if (deliverableIntent === "document" && !documentKind) return null;
  const wantedSections = Array.isArray(record.wantedSections)
    ? record.wantedSections.filter(
        (value): value is "methods" | "results" | "limitations" =>
          typeof value === "string" && VALID_WANTED_SECTIONS.has(value),
      )
    : [];
  return {
    schemaVersion: 1,
    taskKind: record.taskKind as SkillRouterResponseV1["taskKind"],
    queryLanguage:
      typeof record.queryLanguage === "string"
        ? record.queryLanguage.trim().toLowerCase().slice(0, 12) || undefined
        : undefined,
    requestedScopes,
    selections,
    retrievalIntent,
    deliverableIntent,
    documentKind,
    paperTargetIntent,
    externalSearchIntent,
    wantedSections,
  };
}

function resolveEvidenceSpan(
  message: string,
  evidenceText: string,
  occurrence = 0,
): { text: string; start: number; end: number } | null {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    start = message.indexOf(evidenceText, from);
    if (start < 0) return null;
    from = start + evidenceText.length;
  }
  return { text: evidenceText, start, end: start + evidenceText.length };
}

function isScopeCompatible(
  skill: AgentSkill,
  scope: SkillRequestedScope,
): boolean {
  if (skill.contexts.includes("any")) return true;
  return scope !== "none" && skill.contexts.includes(scope);
}

async function hashInstruction(skill: AgentSkill): Promise<string> {
  return `sha256:${await sha256Text(skill.instruction)}`;
}

async function hashSkillManifest(
  skills: ReadonlyArray<AgentSkill>,
): Promise<string> {
  const canonical = skills
    .map((skill) => ({
      id: skill.id,
      version: skill.version,
      description: skill.description,
      contexts: [...skill.contexts].sort(),
      activation: skill.activation,
      supersedes: [...(skill.supersedes || [])].sort(),
      instruction: skill.instruction,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `sha256:${await sha256Text(canonicalJson(canonical))}`;
}

async function validateSkillRouterSelections(params: {
  response: SkillRouterResponseV1;
  request: AgentRuntimeRequest;
  skills: ReadonlyArray<AgentSkill>;
}): Promise<ValidatedSkillActivation[]> {
  const byId = new Map(params.skills.map((skill) => [skill.id, skill]));
  const available = new Set(
    resolveSkillRequestContext(params.request).availableContexts,
  );
  const requested = new Set(params.response.requestedScopes);
  const validated: ValidatedSkillActivation[] = [];
  for (const selection of params.response.selections) {
    const skill = byId.get(selection.skillId);
    if (!skill || !requested.has(selection.requestedScope)) continue;
    if (!isScopeCompatible(skill, selection.requestedScope)) continue;
    if (
      !skill.contexts.includes("any") &&
      !available.has(selection.requestedScope as never)
    )
      continue;
    const evidence = resolveEvidenceSpan(
      params.request.userText || "",
      selection.evidenceText,
      selection.occurrence || 0,
    );
    if (!evidence) continue;
    validated.push({
      id: skill.id,
      source: "automatic",
      requestedScope: selection.requestedScope,
      evidence,
      version: skill.version,
      instructionHash: await hashInstruction(skill),
    });
  }
  return validated;
}

async function buildExplicitActivations(
  request: AgentRuntimeRequest,
  skills: ReadonlyArray<AgentSkill>,
): Promise<ValidatedSkillActivation[]> {
  const forced = new Set(request.forcedSkillIds || []);
  const available = resolveSkillRequestContext(request).availableContexts;
  const fallbackScope: SkillRequestedScope =
    available.find((context) => context !== "any") || "none";
  return Promise.all(
    skills
      .filter((skill) => forced.has(skill.id))
      .map(async (skill) => ({
        id: skill.id,
        source: "explicit" as const,
        requestedScope: fallbackScope,
        version: skill.version,
        instructionHash: await hashInstruction(skill),
      })),
  );
}

function reduceValidatedActivations(
  activations: ValidatedSkillActivation[],
  skills: ReadonlyArray<AgentSkill>,
): ValidatedSkillActivation[] {
  const explicit = activations.filter((entry) => entry.source === "explicit");
  const explicitIds = new Set(explicit.map((entry) => entry.id));
  const automatic = activations.filter((entry) => entry.source === "automatic");
  const superseded = new Set<string>();
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  for (const activation of automatic) {
    for (const id of skillsById.get(activation.id)?.supersedes || []) {
      if (!explicitIds.has(id)) superseded.add(id);
    }
  }
  const seen = new Set<string>();
  const reducedAutomatic = automatic
    .filter((entry) => !superseded.has(entry.id))
    .sort(
      (left, right) =>
        (left.evidence?.start ?? Number.MAX_SAFE_INTEGER) -
          (right.evidence?.start ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    )
    .filter((entry) => {
      const key = `${entry.id}\u0000${entry.requestedScope}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  return [...explicit, ...reducedAutomatic];
}

async function buildRouterCacheIdentity(
  request: AgentRuntimeRequest,
  skills: ReadonlyArray<AgentSkill>,
): Promise<string> {
  const context = resolveSkillRequestContext(request);
  const identity = {
    schemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
    promptVersion: SKILL_ROUTER_PROMPT_VERSION,
    adapterProtocolVersion: SKILL_ROUTER_ADAPTER_PROTOCOL_VERSION,
    providerProtocol: request.providerProtocol,
    authMode: request.authMode,
    model: request.model,
    apiBase: request.apiBase || "",
    profileOverride: request.advanced?.profileOverride || "",
    userMessage: request.userText || "",
    structuredContext: {
      availableContexts: [...context.availableContexts].sort(),
      papers: request.turnPaperScope.papers.map((entry) => ({
        itemId: entry.paper.itemId,
        contextItemId: entry.paper.contextItemId,
        roles: [...entry.roles].sort(),
      })),
      collections: request.turnPaperScope.collections.map((entry) => ({
        libraryID: entry.libraryID,
        collectionId: entry.collectionId,
      })),
      tags: request.turnPaperScope.tags.map((entry) => ({
        libraryID: entry.libraryID,
        name: entry.normalizedName || entry.name,
      })),
      activeNoteId: request.activeNoteContext?.noteId,
      selectedTextSources: [...(request.selectedTextSources || [])],
      selectedTextCount: request.selectedTexts?.length || 0,
      screenshotCount: request.screenshots?.length || 0,
      attachments: (request.attachments || []).map((attachment) => ({
        id: attachment.id,
        category: attachment.category,
      })),
    },
    explicitSkillIds: [...(request.forcedSkillIds || [])].sort(),
    candidateManifestHash: await hashSkillManifest(skills),
  };
  return `sha256:${await sha256Text(canonicalJson(identity))}`;
}

async function classifyActionIntent(
  request: AgentRuntimeRequest,
  router: SkillRouterResponseV1,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    llmCall?: UtilityLLMParams["llmCall"];
  },
): Promise<ClassifiedTurnIntent["actionIntents"] | null> {
  const result = await callUtilityLLM({
    prompt: [
      "Classify only the exact mutation obligations in this Zotero request.",
      "Questions, advice, negation, hypotheticals, and reads have no mutation actions.",
      "Tag verbs are literal: add is apply_tags, remove is remove_tags, replace is set_item_tags.",
      "Available external operations include note_create, note_edit, note_append, annotation_write, settings_update, undo, revert, file_write, command_execute, zotero_script_execute, and read_full.",
      `Router task kind: ${router.taskKind}`,
      "User message:",
      request.userText || "",
      'Reply only with JSON: {"retrievalIntent":"none","wantedSections":[],"writeDisposition":"none|required|uncertain","actionIntents":[]}',
    ].join("\n"),
    model: request.model,
    apiBase: request.apiBase,
    apiKey: request.apiKey,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
    jsonBudget: 350,
    temperature: 0,
    signal: options.signal,
    timeoutMs: options.timeoutMs || TURN_INTENT_TIMEOUT_MS,
    llmCall: options.llmCall,
  });
  if (!result.ok) return null;
  const classified = parseClassifiedTurnIntent(result.text)?.actionIntents;
  if (!classified) return null;
  const deterministic = inferActionIntentsFromRequest(request);
  if (deterministic.length) {
    const expected = deterministic
      .map((intent) => intent.operation)
      .sort()
      .join("|");
    const actual = classified
      .map((intent) => intent.operation)
      .sort()
      .join("|");
    if (expected !== actual) return null;
  }
  return classified;
}

export function clearSkillRouterCache(): void {
  routerCache.clear();
}

export async function resolvePlanSkillRoutingReceipt(
  receipt: PlanSkillRoutingReceipt | undefined,
  skills: ReadonlyArray<AgentSkill>,
): Promise<{
  skillIds: string[];
  changedAutomaticSkillIds: string[];
  changedExplicitSkillIds: string[];
}> {
  if (!receipt) {
    return {
      skillIds: [],
      changedAutomaticSkillIds: [],
      changedExplicitSkillIds: [],
    };
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const skillIds: string[] = [];
  const changedAutomaticSkillIds: string[] = [];
  const changedExplicitSkillIds: string[] = [];
  for (const routed of receipt.skills) {
    const current = byId.get(routed.id);
    const unchanged = Boolean(
      current &&
      current.version === routed.version &&
      (await hashInstruction(current)) === routed.instructionHash,
    );
    if (unchanged) {
      skillIds.push(routed.id);
    } else if (routed.source === "explicit") {
      changedExplicitSkillIds.push(routed.id);
    } else {
      changedAutomaticSkillIds.push(routed.id);
    }
  }
  return { skillIds, changedAutomaticSkillIds, changedExplicitSkillIds };
}

const VALID_RETRIEVAL_INTENTS = new Set([
  "enumerate",
  "verify",
  "summarize",
  "none",
]);
const VALID_PAPER_TARGET_INTENTS = new Set([
  "active",
  "added",
  "all_visible",
  "unspecified",
]);
const VALID_EXTERNAL_SEARCH_INTENTS = new Set([
  "none",
  "web",
  "literature",
  "both",
]);
const VALID_WANTED_SECTIONS = new Set(["methods", "results", "limitations"]);

/**
 * Parse the language-independent intent fields out of the classifier reply.
 * Strict on the enum: anything unexpected returns null so downstream
 * consumers keep exactly the pre-classifier behavior. Unknown wantedSections
 * entries are dropped (they are additive hints, not a contract).
 */
export function parseClassifiedTurnIntent(
  raw: string,
): ClassifiedTurnIntent | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    retrievalIntent?: unknown;
    paperTargetIntent?: unknown;
    externalSearchIntent?: unknown;
    deliverableIntent?: unknown;
    documentKind?: unknown;
    wantedSections?: unknown;
    queryLanguage?: unknown;
    writeDisposition?: unknown;
    actionIntents?: unknown;
  };
  const retrievalIntent =
    typeof record.retrievalIntent === "string"
      ? record.retrievalIntent.trim()
      : "";
  if (!VALID_RETRIEVAL_INTENTS.has(retrievalIntent)) return null;
  const paperTargetIntent =
    typeof record.paperTargetIntent === "string" &&
    VALID_PAPER_TARGET_INTENTS.has(record.paperTargetIntent.trim())
      ? (record.paperTargetIntent.trim() as NonNullable<
          ClassifiedTurnIntent["paperTargetIntent"]
        >)
      : undefined;
  const externalSearchIntent =
    typeof record.externalSearchIntent === "string" &&
    VALID_EXTERNAL_SEARCH_INTENTS.has(record.externalSearchIntent.trim())
      ? (record.externalSearchIntent.trim() as NonNullable<
          ClassifiedTurnIntent["externalSearchIntent"]
        >)
      : undefined;
  const deliverableIntent = ["chat", "document", "unspecified"].includes(
    String(record.deliverableIntent),
  )
    ? (record.deliverableIntent as NonNullable<
        ClassifiedTurnIntent["deliverableIntent"]
      >)
    : undefined;
  const documentKind = [
    "research_brief",
    "literature_review",
    "comparison",
    "report",
    "guide",
    "custom",
  ].includes(String(record.documentKind))
    ? (record.documentKind as NonNullable<ClassifiedTurnIntent["documentKind"]>)
    : undefined;
  if (deliverableIntent === "document" && !documentKind) return null;
  const wantedSections = Array.isArray(record.wantedSections)
    ? record.wantedSections
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value): value is "methods" | "results" | "limitations" =>
          VALID_WANTED_SECTIONS.has(value),
        )
    : [];
  const queryLanguage =
    typeof record.queryLanguage === "string" && record.queryLanguage.trim()
      ? record.queryLanguage.trim().toLowerCase().slice(0, 12)
      : undefined;
  const actionIntents = parseActionIntents(record.actionIntents);
  const writeDisposition =
    record.writeDisposition === "none" ||
    record.writeDisposition === "required" ||
    record.writeDisposition === "uncertain"
      ? record.writeDisposition
      : actionIntents.some((intent) => intent.operation !== "read_full")
        ? "required"
        : "none";
  if (writeDisposition === "required" && !actionIntents.length) return null;
  return {
    retrievalIntent: retrievalIntent as ClassifiedTurnIntent["retrievalIntent"],
    ...(paperTargetIntent ? { paperTargetIntent } : {}),
    ...(externalSearchIntent ? { externalSearchIntent } : {}),
    ...(deliverableIntent ? { deliverableIntent } : {}),
    ...(documentKind ? { documentKind } : {}),
    wantedSections,
    queryLanguage,
    writeDisposition,
    actionInterpretationSource: "classifier",
    actionIntents,
  };
}

/**
 * Parse the classifier's response into a list of valid skill IDs.
 * Legacy response parser retained for compatibility tests and old persisted
 * diagnostics. It is not used by automatic routing.
 */
export function parseClassifierResponse(
  raw: string,
  skills: AgentSkill[],
): string[] | null {
  if (!raw) return null;
  // Tolerate code fences or surrounding prose — extract the first {…} blob.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const ids = (parsed as { skillIds?: unknown }).skillIds;
  if (!Array.isArray(ids)) return null;

  const validIds = new Set(skills.map((s) => s.id));
  const rawStrings = ids
    .filter((value): value is string => typeof value === "string")
    .map((s) => s.trim());
  const hasUnmatched = rawStrings.includes(UNMATCHED_ID);
  const realIds = rawStrings.filter(
    (id) => id !== UNMATCHED_ID && validIds.has(id),
  );

  // Hedge case: model returned both "unmatched" and real skill IDs. Trust
  // the real picks — the model found something worth loading. Drop
  // "unmatched".
  if (realIds.length > 0) return realIds;
  // Explicit no-match: model chose only "unmatched", or returned an empty
  // array. Both are valid "no skills apply" responses.
  if (hasUnmatched || rawStrings.length === 0) return [];
  // Fallthrough: only invalid skill IDs (hallucinated names). Treat as
  // unmatched so we don't load anything bogus.
  return [];
}
