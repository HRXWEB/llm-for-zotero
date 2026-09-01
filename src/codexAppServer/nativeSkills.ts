import type {
  ChatAttachment,
  CollectionContextRef,
  NoteContextRef,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../shared/types";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
} from "../agent/types";
import { resolveAgentRuntimeRequest } from "../agent/context/resolvedAgentRequest";
import type { AgentSkill } from "../agent/skills";
import { getAllSkills, getMatchedSkillIds } from "../agent/skills";
import { getSkillCustomizationNotice } from "../agent/skills/managedBlock";
import { detectSkillIntent } from "../agent/model/skillClassifier";
import { RAW_PDF_TRANSPORT_POLICY_BLOCK } from "../agent/context/rawPdfTransportPolicy";
import type { CodexNativeSkillRoutingMode } from "./prefs";

const CLASSIFIER_CACHE_MAX_ENTRIES = 200;

const classifierCache = new Map<string, string[]>();

export type CodexNativeSkillScope = {
  profileSignature?: string;
  conversationKey: number;
  libraryID: number;
  kind: "global" | "paper";
  activeItemId?: number;
  paperItemID?: number;
  activeContextItemId?: number;
  paperTitle?: string;
  paperContext?: PaperContextRef;
  activeNoteId?: number;
  activeNoteTitle?: string;
  activeNoteKind?: "item" | "standalone";
  activeNoteParentItemId?: number;
};

export type CodexNativeSkillContext = {
  forcedSkillIds?: string[];
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  selectedPaperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  localDocuments?: readonly import("../shared/types").LocalDocumentResource[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  screenshots?: string[];
  attachments?: ChatAttachment[];
};

export type CodexNativeResolvedSkills = {
  request: AgentRuntimeRequest;
  matchedSkillIds: string[];
  instructionBlock: string;
  resolutionSource?: "none" | "deterministic" | "classifier" | "cache";
};

type ResolveNativeSkillsParams = {
  scope: CodexNativeSkillScope;
  userText: string;
  model: string;
  apiBase?: string;
  signal?: AbortSignal;
  skillContext?: CodexNativeSkillContext;
  detectSkillIntentImpl?: typeof detectSkillIntent;
};

export function clearCodexNativeSkillClassifierCache(): void {
  classifierCache.clear();
}

export function resolveExplicitCodexNativeSkillIds(
  forcedSkillIds: ReadonlyArray<string>,
): string[] {
  const knownSkillIds = new Set(getAllSkills().map((skill) => skill.id));
  return Array.from(
    new Set(forcedSkillIds.filter((skillId) => knownSkillIds.has(skillId))),
  );
}

function uniqueInSkillOrder(
  ids: ReadonlySet<string>,
  allSkills: ReadonlyArray<AgentSkill>,
): string[] {
  return allSkills
    .filter((skill) => ids.has(skill.id))
    .map((skill) => skill.id);
}

export function resolveDeterministicCodexNativeSkillIds(params: {
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
}): string[] {
  const allSkills = params.allSkills || getAllSkills();
  if (!allSkills.length) return [];
  const matched = new Set(
    resolveExplicitCodexNativeSkillIds(params.request.forcedSkillIds || []),
  );
  return uniqueInSkillOrder(matched, allSkills);
}

export function shouldUseCodexNativeSkillClassifierFallback(params: {
  mode?: CodexNativeSkillRoutingMode;
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
  deterministicSkillIds?: ReadonlyArray<string>;
}): boolean {
  const allSkills = params.allSkills || getAllSkills();
  if (!allSkills.length) return false;
  if (params.deterministicSkillIds?.length) return false;
  return (
    params.mode === "classifier" &&
    Boolean((params.request.userText || "").trim())
  );
}

function buildSkillVersionSignature(
  allSkills: ReadonlyArray<AgentSkill>,
): string {
  return allSkills
    .map((skill) =>
      [
        skill.id,
        skill.version,
        skill.source,
        skill.description,
        [...skill.contexts].sort().join("|"),
        [...(skill.supersedes || [])].sort().join("|"),
        skill.instruction,
      ].join(":"),
    )
    .sort()
    .join(";");
}

export function buildCodexNativeSkillClassifierCacheKey(params: {
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
}): string {
  const request = params.request;
  const allSkills = params.allSkills || getAllSkills();
  return JSON.stringify({
    prompt: request.userText || "",
    context: {
      activeNote: Boolean(request.activeNoteContext),
      selectedTextSources: Array.from(
        new Set(request.selectedTextSources || []),
      ).sort(),
      selectedTextCount: request.selectedTexts?.length || 0,
      selectedPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("selected"),
      ).length,
      fullTextPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("full_text"),
      ).length,
      pinnedPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("pinned"),
      ).length,
      collectionCount: request.turnPaperScope.collections.length,
      tagCount: request.turnPaperScope.tags.length,
      screenshotCount: request.screenshots?.length || 0,
      attachmentTypes: Array.from(
        new Set(
          (request.attachments || []).map((attachment) => attachment.category),
        ),
      ).sort(),
    },
    skills: buildSkillVersionSignature(allSkills),
  });
}

function setClassifierCache(key: string, value: string[]): void {
  classifierCache.set(key, [...value]);
  if (classifierCache.size <= CLASSIFIER_CACHE_MAX_ENTRIES) return;
  const firstKey = classifierCache.keys().next().value;
  if (firstKey) classifierCache.delete(firstKey);
}

function normalizeList<T>(value: readonly T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length ? Array.from(value) : undefined;
}

function buildScopePaperContexts(
  scope: CodexNativeSkillScope,
): PaperContextRef[] | undefined {
  if (scope.paperContext) return [scope.paperContext];
  if (
    scope.kind !== "paper" ||
    !scope.paperItemID ||
    !scope.activeContextItemId
  ) {
    return undefined;
  }
  return [
    {
      itemId: scope.paperItemID,
      contextItemId: scope.activeContextItemId,
      title: scope.paperTitle || `Paper ${scope.paperItemID}`,
    },
  ];
}

function buildScopeActiveNoteContext(
  scope: CodexNativeSkillScope,
): AgentRuntimeRequest["activeNoteContext"] {
  if (!scope.activeNoteId) return undefined;
  return {
    noteId: scope.activeNoteId,
    title: scope.activeNoteTitle || `Note ${scope.activeNoteId}`,
    noteKind: scope.activeNoteKind || "standalone",
    parentItemId: scope.activeNoteParentItemId,
    noteText: "",
  };
}

export function buildCodexNativeSkillRequest(
  params: Omit<ResolveNativeSkillsParams, "signal" | "detectSkillIntentImpl">,
): AgentRuntimeRequest {
  const { scope, skillContext } = params;
  const scopePapers = buildScopePaperContexts(scope);
  const rawRequest: AgentRuntimeRequestInput = {
    conversationKey: scope.conversationKey,
    mode: "agent",
    userText: params.userText,
    activeItemId: scope.activeItemId || scope.paperItemID,
    libraryID: scope.libraryID,
    conversationKind: scope.kind === "paper" ? "paper" : "global",
    selectedTextContexts: normalizeList(skillContext?.selectedTextContexts),
    resolvedSelectedTextAnchors: normalizeList(
      skillContext?.resolvedSelectedTextAnchors,
    ),
    selectedTexts: normalizeList(skillContext?.selectedTexts),
    selectedTextSources: normalizeList(skillContext?.selectedTextSources),
    selectedTextPaperContexts: normalizeList(
      skillContext?.selectedTextPaperContexts,
    ),
    selectedTextNoteContexts: normalizeList(
      skillContext?.selectedTextNoteContexts,
    ),
    selectedPaperContexts:
      normalizeList(skillContext?.selectedPaperContexts) || scopePapers,
    pdfPaperContexts: normalizeList(skillContext?.pdfPaperContexts),
    localDocuments: normalizeList(skillContext?.localDocuments),
    fullTextPaperContexts: normalizeList(skillContext?.fullTextPaperContexts),
    pinnedPaperContexts: normalizeList(skillContext?.pinnedPaperContexts),
    selectedCollectionContexts: normalizeList(
      skillContext?.selectedCollectionContexts,
    ),
    selectedTagContexts: normalizeList(skillContext?.selectedTagContexts),
    attachments: normalizeList(skillContext?.attachments),
    screenshots: normalizeList(skillContext?.screenshots),
    forcedSkillIds: normalizeList(skillContext?.forcedSkillIds),
    model: params.model,
    apiBase: params.apiBase,
    authMode: "codex_app_server",
    providerProtocol: "codex_responses",
    activeNoteContext: buildScopeActiveNoteContext(scope),
    modelProviderLabel: "Codex",
  };
  return resolveAgentRuntimeRequest(rawRequest);
}

export function buildCodexNativeSkillInstructionBlock(
  matchedSkillIds: ReadonlyArray<string>,
  allSkills: ReadonlyArray<AgentSkill> = getAllSkills(),
  options: { rawPdfMode?: boolean } = {},
): string {
  if (!matchedSkillIds.length) return "";
  const activeIds = new Set(matchedSkillIds);
  const matchedSkills = allSkills.filter((skill) => activeIds.has(skill.id));
  if (!matchedSkills.length) return "";
  return [
    "LLM-for-Zotero skills active for this turn:",
    "The following skill instructions are provided because the user's message matches these workflows. Use them as workflow guidance for Zotero MCP tools; do not treat skills as additional MCP tools.",
    ...matchedSkills.map((skill) =>
      [
        `Skill: ${skill.id}`,
        getSkillCustomizationNotice(skill.instruction) || "",
        skill.instruction.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    options.rawPdfMode ? RAW_PDF_TRANSPORT_POLICY_BLOCK : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveCodexNativeSkills(
  params: ResolveNativeSkillsParams,
): Promise<CodexNativeResolvedSkills> {
  const request = buildCodexNativeSkillRequest(params);
  const rawPdfMode = Boolean(params.skillContext?.localDocuments?.length);
  const allSkills = getAllSkills();
  if (!allSkills.length) {
    return {
      request,
      matchedSkillIds: [],
      instructionBlock: "",
      resolutionSource: "none",
    };
  }
  const deterministicSkillIds = resolveDeterministicCodexNativeSkillIds({
    request,
    allSkills,
  });
  if (deterministicSkillIds.length) {
    return {
      request,
      matchedSkillIds: deterministicSkillIds,
      instructionBlock: buildCodexNativeSkillInstructionBlock(
        deterministicSkillIds,
        allSkills,
        { rawPdfMode },
      ),
      resolutionSource: "deterministic",
    };
  }

  if (
    !shouldUseCodexNativeSkillClassifierFallback({
      // Codex currently cannot prove a truly no-tools classifier thread.
      // Automatic routing therefore remains unavailable unless a caller
      // supplies an isolated classifier adapter explicitly.
      mode: params.detectSkillIntentImpl ? "classifier" : "deterministic",
      request,
      allSkills,
      deterministicSkillIds,
    })
  ) {
    return {
      request,
      matchedSkillIds: [],
      instructionBlock: "",
      resolutionSource: "none",
    };
  }

  const cacheKey = buildCodexNativeSkillClassifierCacheKey({
    request,
    allSkills,
  });
  if (classifierCache.has(cacheKey)) {
    const cachedSkillIds = classifierCache.get(cacheKey) || [];
    return {
      request,
      matchedSkillIds: [...cachedSkillIds],
      instructionBlock: buildCodexNativeSkillInstructionBlock(
        cachedSkillIds,
        allSkills,
        { rawPdfMode },
      ),
      resolutionSource: "cache",
    };
  }

  const classify = params.detectSkillIntentImpl || detectSkillIntent;
  const classifiedSkillIds = await classify(
    request,
    [...allSkills],
    params.signal,
  );
  const matchedSkillIds = getMatchedSkillIds(request, classifiedSkillIds);
  setClassifierCache(cacheKey, matchedSkillIds);
  return {
    request,
    matchedSkillIds,
    instructionBlock: buildCodexNativeSkillInstructionBlock(
      matchedSkillIds,
      allSkills,
      { rawPdfMode },
    ),
    resolutionSource: "classifier",
  };
}
