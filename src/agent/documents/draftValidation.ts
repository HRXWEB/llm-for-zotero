const QUOTE_TOKEN = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;

/**
 * The coverage disclosure rule in the words the validator enforces. Every
 * instruction that asks for the disclosure renders this text so the model is
 * never told one vocabulary and validated against another.
 */
export const COVERAGE_DISCLOSURE_REQUIREMENT =
  'Coverage disclosure required: one heading containing "scope" and one heading containing "limitations"; a single "Scope and limitations" section satisfies both.';

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ");
}

function collectHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) headings.add(normalizeHeading(match[1]));
  }
  return headings;
}

function hasCoverageDisclosure(headings: ReadonlySet<string>): boolean {
  const values = [...headings];
  const hasScope = values.some((heading) => /\bscope\b/.test(heading));
  const hasLimitations = values.some((heading) =>
    /\blimit(?:ation|ations|s)\b/.test(heading),
  );
  return hasScope && hasLimitations;
}

function collectMissingSections(params: {
  headings: ReadonlySet<string>;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
}): string[] {
  const coverageSatisfied = hasCoverageDisclosure(params.headings);
  const required = params.requiredSections
    .map(normalizeHeading)
    .filter((heading) => heading !== "references");
  if (params.requiresCoverageSection) required.push("scope and limitations");
  return [...new Set(required)].filter((heading) => {
    if (heading === "scope and limitations" && coverageSatisfied) return false;
    return !params.headings.has(heading);
  });
}

export function collectDocumentDraftIssues(params: {
  markdown: string;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
  validateQuotes?: boolean;
}): string[] {
  const issues: string[] = [];
  const missing = collectMissingSections({
    headings: collectHeadings(params.markdown),
    requiredSections: params.requiredSections,
    requiresCoverageSection: params.requiresCoverageSection,
  });
  if (missing.length) {
    issues.push(`Document is missing required sections: ${missing.join(", ")}`);
  }
  if (params.validateQuotes !== false) {
    const proseWithoutTokens = params.markdown.replace(QUOTE_TOKEN, "");
    const hasDirectQuote =
      /^\s*>\s+\S/m.test(proseWithoutTokens) ||
      /(?:^|[\s(])["“][^"”\n]{20,}["”]/m.test(proseWithoutTokens);
    if (hasDirectQuote) {
      issues.push(
        "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
      );
    }
  }
  return issues;
}

export function assertDocumentDraftValid(params: {
  markdown: string;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
  validateQuotes?: boolean;
}): void {
  const issues = collectDocumentDraftIssues(params);
  if (issues.length) {
    throw new Error(`Document validation failed:\n- ${issues.join("\n- ")}`);
  }
}

export function stripHandwrittenReferences(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let suppressedDepth = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (suppressedDepth && depth <= suppressedDepth) {
        suppressedDepth = 0;
        if (kept.length && kept.at(-1) !== "") kept.push("");
      }
      if (normalizeHeading(heading[2]) === "references") {
        suppressedDepth = depth;
        while (kept.at(-1) === "") kept.pop();
        continue;
      }
    }
    if (!suppressedDepth) kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  return kept.join("\n");
}
