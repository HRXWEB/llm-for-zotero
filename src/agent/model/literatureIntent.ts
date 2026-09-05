/** User selection is a workflow requirement, independent of permission mode. */
export function requiresLiteratureSelection(text: string): boolean {
  return /\b(?:papers?|studies|articles?|ones|those)\s+(?:that\s+)?(?:I|we)\s+(?:(?:will|later)\s+)?(?:select|choose|approve)\b|\b(?:after|until|once|before)\s+(?:I|we)\s+(?:select|choose|approve|confirm)\b|\b(?:let|allow)\s+me\s+(?:select|choose|approve)\b/i.test(
    text,
  );
}

export function isExplicitLiteratureImport(text: string): boolean {
  if (requiresLiteratureSelection(text)) return false;
  return /(?:^|[.!?]\s*|\band\s+)(?:please\s+)?import\b|\b(?:find|search)\s+and\s+import\b/i.test(
    text,
  );
}

export function isLiteratureDiscovery(text: string): boolean {
  return (
    requiresLiteratureSelection(text) ||
    (!isExplicitLiteratureImport(text) &&
      /\b(?:find|discover|recommend|suggest)\b[^.!?\n]{0,100}\b(?:papers?|studies|articles?)\b/i.test(
        text,
      ))
  );
}

/** Exact quantities stated next to the requested papers, not years or IDs. */
export function requestedLiteratureCount(text: string): number | undefined {
  const words = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
  ];
  const match = new RegExp(
    `\\b(\\d+|${words.join("|")})\\s+(?:(?:most|top|highly|closely|relevant|related|similar|new|best)\\s+){0,4}(?:papers?|studies|articles?)\\b`,
    "i",
  ).exec(text);
  if (!match) return undefined;
  const count = /^\d+$/.test(match[1])
    ? Number(match[1])
    : words.indexOf(match[1].toLowerCase()) + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}
