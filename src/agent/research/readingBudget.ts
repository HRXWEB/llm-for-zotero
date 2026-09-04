import { TOKEN_ESTIMATE_CHARS_PER_TOKEN } from "../../utils/modelInputCap";

export type AdaptiveReviewContract = Readonly<{
  reviewMode?: "narrative" | "scoping" | "systematic";
  readingStrategy?: "adaptive" | "selected";
  requiredEvidenceDepth: "metadata" | "abstract" | "body";
  estimatedDeepReadPapers: number;
}>;

export type AdaptiveReadingBudget = Readonly<{
  contextWindowTokens: number;
  usedContextTokens: number;
  outputReserveTokens: number;
  remainingInputTokens: number;
  allocatedReadingTokens: number;
  tokensPerPaper: number;
  maxCharactersPerPaper: number;
}>;

/**
 * Resolve how many approved papers the research job promises to understand at
 * body level. Adaptive reviews inherit the frozen scope instead of asking the
 * planner to invent a paper count. Selected/systematic workflows retain their
 * explicit, user-visible estimate.
 */
export function resolvePlannedReadingPapers(
  investigation: AdaptiveReviewContract,
  frozenPaperCount: number,
): number {
  if (
    investigation.readingStrategy === "adaptive" &&
    investigation.requiredEvidenceDepth === "body"
  ) {
    return Math.max(0, Math.floor(frozenPaperCount));
  }
  return Math.max(0, Math.floor(investigation.estimatedDeepReadPapers));
}

/**
 * Allocate source text from the actual remaining model context. This is a
 * capacity calculation, not a small/medium/large corpus policy: adding papers
 * reduces each paper's share, while a larger live context permits deeper reads.
 */
export function resolveAdaptiveReadingBudget(params: {
  contextWindowTokens: number;
  usedContextTokens: number;
  outputReserveTokens: number;
  paperCount: number;
}): AdaptiveReadingBudget {
  const contextWindowTokens = Math.max(
    1,
    Math.floor(params.contextWindowTokens),
  );
  const usedContextTokens = Math.max(0, Math.floor(params.usedContextTokens));
  const outputReserveTokens = Math.max(
    0,
    Math.floor(params.outputReserveTokens),
  );
  const paperCount = Math.max(1, Math.floor(params.paperCount));
  const remainingInputTokens = Math.max(
    0,
    contextWindowTokens - usedContextTokens - outputReserveTokens,
  );
  // Keep a proportional serialization/safety margin for tool envelopes and
  // the next model turn. The allocation still grows continuously with the
  // provider's measured remaining capacity.
  const allocatedReadingTokens = Math.max(
    0,
    Math.floor(remainingInputTokens * 0.8),
  );
  const tokensPerPaper = Math.max(
    1,
    Math.floor(allocatedReadingTokens / paperCount),
  );
  return {
    contextWindowTokens,
    usedContextTokens,
    outputReserveTokens,
    remainingInputTokens,
    allocatedReadingTokens,
    tokensPerPaper,
    maxCharactersPerPaper: tokensPerPaper * TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  };
}
