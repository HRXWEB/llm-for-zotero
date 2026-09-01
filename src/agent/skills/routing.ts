import type { AgentRuntimeRequest } from "../types";
import {
  isSkillContextEligible,
  type SkillRoutingRequest,
} from "./contextEligibility";
import type { AgentSkill } from "./skillLoader";

export type SkillRoutingResolution = {
  matchedSkillIds: string[];
  explicitSkillIds: string[];
  contextForcedSkillIds: string[];
};

export type SkillDirectiveTextResolution = {
  text: string;
  forcedSkillId?: string;
};

type NaturalLanguageSkillDirective = {
  skillPhrase: string;
  rest: string;
};

type SkillCandidateScore = {
  skill: AgentSkill;
  score: number;
};

const NATURAL_SKILL_DIRECTIVE_PATTERN =
  /^(?:(?:please|pls)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:please|pls)\s+)?(?:use|using|with|activate|run|invoke)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+skill\b([\s\S]*)$/i;

const NATURAL_SKILL_MIN_SCORE = 70;
const NATURAL_SKILL_MIN_MARGIN = 10;
const DESCRIPTION_TOKEN_SCORE = 62;
const SKILL_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "can",
  "could",
  "for",
  "from",
  "help",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "skill",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "using",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeSkillAliasText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getMeaningfulSkillTokens(value: string): string[] {
  const normalized = normalizeSkillAliasText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token && !SKILL_TOKEN_STOPWORDS.has(token));
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function scoreTokenMatch(queryToken: string, targetToken: string): number {
  if (!queryToken || !targetToken) return 0;
  if (queryToken === targetToken) return 1;
  if (
    queryToken.length >= 4 &&
    targetToken.length >= 4 &&
    (queryToken.startsWith(targetToken) || targetToken.startsWith(queryToken))
  ) {
    return 0.9;
  }
  const maxLength = Math.max(queryToken.length, targetToken.length);
  if (maxLength >= 4 && levenshteinDistance(queryToken, targetToken) <= 1) {
    return 0.85;
  }
  return 0;
}

function scoreIdAliasMatch(skill: AgentSkill, phraseTokens: string[]): number {
  const idTokens = getMeaningfulSkillTokens(skill.id);
  if (!phraseTokens.length || !idTokens.length) return 0;

  if (phraseTokens.join("") === idTokens.join("")) return 100;

  if (phraseTokens.length < 2 || phraseTokens.length > idTokens.length) {
    return 0;
  }

  const tokenScores = phraseTokens.map((token, index) =>
    scoreTokenMatch(token, idTokens[index] || ""),
  );
  if (tokenScores.some((score) => score <= 0)) return 0;

  const average =
    tokenScores.reduce((total, score) => total + score, 0) / tokenScores.length;
  return 78 + average * 12 + phraseTokens.length;
}

function scoreDescriptionMatch(
  skill: AgentSkill,
  phraseTokens: string[],
): number {
  if (phraseTokens.length < 2) return 0;
  const descriptionTokens = getMeaningfulSkillTokens(skill.description);
  if (!descriptionTokens.length) return 0;

  const matchedScores = phraseTokens
    .map((token) =>
      Math.max(
        0,
        ...descriptionTokens.map((descriptionToken) =>
          scoreTokenMatch(token, descriptionToken),
        ),
      ),
    )
    .filter((score) => score > 0);
  if (matchedScores.length < 2) return 0;

  return (
    DESCRIPTION_TOKEN_SCORE +
    matchedScores.reduce((total, score) => total + score, 0) * 4
  );
}

function parseNaturalLanguageSkillDirective(
  text: string,
): NaturalLanguageSkillDirective | null {
  const match = NATURAL_SKILL_DIRECTIVE_PATTERN.exec(text.trim());
  if (!match) return null;

  const skillPhrase = (match[1] || "").trim();
  if (!skillPhrase) return null;

  const rest = (match[2] || "")
    .trim()
    .replace(/^[,:;-]\s*/u, "")
    .replace(/^to\s+/i, "")
    .trim();
  return { skillPhrase, rest };
}

function resolveNaturalLanguageSkillId(
  skillPhrase: string,
  skills: ReadonlyArray<AgentSkill>,
): string | undefined {
  const phraseTokens = getMeaningfulSkillTokens(skillPhrase);
  if (!phraseTokens.length) return undefined;

  const scored = skills
    .map(
      (skill): SkillCandidateScore => ({
        skill,
        score: Math.max(
          scoreIdAliasMatch(skill, phraseTokens),
          scoreDescriptionMatch(skill, phraseTokens),
        ),
      }),
    )
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < NATURAL_SKILL_MIN_SCORE) return undefined;

  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < NATURAL_SKILL_MIN_MARGIN) {
    return undefined;
  }

  return top.skill.id;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasSkill(skills: ReadonlyArray<AgentSkill>, skillId: string): boolean {
  return skills.some((skill) => skill.id === skillId);
}

export function resolveSkillRouting(
  request: SkillRoutingRequest & Pick<AgentRuntimeRequest, "forcedSkillIds">,
  skills: ReadonlyArray<AgentSkill>,
  classifiedIds?: ReadonlyArray<string>,
): SkillRoutingResolution {
  const forcedIds = new Set(request.forcedSkillIds || []);
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const explicitSkillIds = Array.from(
    new Set(
      (request.forcedSkillIds || []).filter((id) => skillsById.has(id)),
    ),
  );
  const automatic = Array.from(new Set(classifiedIds || [])).filter((id) => {
    const skill = skillsById.get(id);
    if (!skill || forcedIds.has(id) || skill.activation === "manual")
      return false;
    return isSkillContextEligible(skill, request);
  });
  const automaticSet = new Set(automatic);
  for (const skill of skills) {
    if (!automaticSet.has(skill.id)) continue;
    for (const supersededId of skill.supersedes || []) {
      if (!forcedIds.has(supersededId)) automaticSet.delete(supersededId);
    }
  }
  const automaticSkillIds = automatic
    .filter((id) => automaticSet.has(id))
    .slice(0, 3)
    .map((id) => id);

  return {
    matchedSkillIds: [...explicitSkillIds, ...automaticSkillIds],
    explicitSkillIds,
    contextForcedSkillIds: [],
  };
}

export function resolveSkillDirectiveText(
  text: string,
  skills: ReadonlyArray<AgentSkill>,
): SkillDirectiveTextResolution {
  const trimmed = text.trim();
  const nativeMatch = /^\$([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (nativeMatch) {
    const skillId = nativeMatch[1];
    if (!hasSkill(skills, skillId)) {
      return { text };
    }
    return { text: trimmed, forcedSkillId: skillId };
  }
  const slashMatch = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (slashMatch) {
    const skillId = slashMatch[1];
    if (!hasSkill(skills, skillId)) {
      return { text };
    }
    const rest = (slashMatch[2] || "").trim();
    return {
      text: rest ? `$${skillId}\n\n${rest}` : `$${skillId}`,
      forcedSkillId: skillId,
    };
  }

  const directive = parseNaturalLanguageSkillDirective(trimmed);
  if (!directive) return { text };

  const naturalSkillId = resolveNaturalLanguageSkillId(
    directive.skillPhrase,
    skills,
  );
  if (!naturalSkillId) return { text };

  return {
    text: directive.rest
      ? `$${naturalSkillId}\n\n${directive.rest}`
      : `$${naturalSkillId}`,
    forcedSkillId: naturalSkillId,
  };
}

export function prependNativeSkillMention(
  question: string,
  skillId: string,
): string {
  const trimmedQuestion = question.trim();
  const nativeSkillPrefix = new RegExp(`^\\$${escapeRegExp(skillId)}(?:\\s|$)`);
  if (nativeSkillPrefix.test(trimmedQuestion)) return question;
  return trimmedQuestion ? `$${skillId}\n\n${question}` : `$${skillId}`;
}
