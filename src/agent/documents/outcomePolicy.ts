import type { AgentRuntimeRequest } from "../types";
import type { DocumentOutcomePolicy, DocumentSpec } from "./types";

export const LITERATURE_REVIEW_SKILL_ID = "literature-review";

const NO_DOCUMENT: DocumentOutcomePolicy = {
  required: false,
  documentKind: "custom",
  integrityPolicy: "authored",
  trigger: "none",
};

function inferExplicitDocumentKind(
  userText: string,
): DocumentSpec["kind"] | null {
  const text = userText.trim().toLowerCase();
  if (!text) return null;
  const negatesAuthorship =
    /\b(?:do\s+not|don't|dont|without)\s+(?:write|draft|author|prepare|create|produce|compose|develop)\b/u.test(
      text,
    );
  const asksAboutAuthorship =
    /\bhow\s+(?:do|can|should|would)\s+(?:i|we|you|one)\s+(?:write|draft|author|prepare|create|produce|compose|develop)\b/u.test(
      text,
    ) ||
    /\b(?:advice|tips|guidance)\s+(?:about|on|for)\s+(?:writing|drafting|authoring|preparing|creating)\b/u.test(
      text,
    );
  if (negatesAuthorship || asksAboutAuthorship) return null;
  const asksToAuthor =
    /\b(?:write|draft|author|prepare|create|produce|compose|develop)\b/u.test(
      text,
    );
  const asksForLiteratureReview =
    /\bliterature[ -]review\b/u.test(text) &&
    (asksToAuthor ||
      /\b(?:conduct|perform|do|provide|give|want|need)\b/u.test(text) ||
      /\bwould\s+like\b/u.test(text));
  if (asksForLiteratureReview) return "literature_review";
  if (!asksToAuthor) return null;
  if (/\bmanuscript\b/u.test(text)) return "custom";
  if (/\bresearch[ -]brief\b/u.test(text)) return "research_brief";
  if (/\bguide\b/u.test(text)) return "guide";
  if (/\breport\b/u.test(text)) return "report";
  if (/\b(?:document|article|paper|essay|whitepaper)\b/u.test(text)) {
    return "custom";
  }
  return null;
}

export function resolveDocumentOutcomePolicy(params: {
  request: AgentRuntimeRequest;
  matchedSkillIds: readonly string[];
  plannedDocumentKind?: DocumentSpec["kind"];
  plannedResearch?: boolean;
}): DocumentOutcomePolicy {
  if (params.request.planContext?.phase === "planning") return NO_DOCUMENT;
  if (params.request.planContext?.phase === "executing") {
    return params.plannedDocumentKind
      ? {
          required: true,
          documentKind: params.plannedDocumentKind,
          integrityPolicy:
            params.plannedResearch ||
            params.plannedDocumentKind === "literature_review"
              ? "research_grounded"
              : "authored",
          trigger: "plan_deliverable",
        }
      : NO_DOCUMENT;
  }
  if (params.matchedSkillIds.includes(LITERATURE_REVIEW_SKILL_ID)) {
    return {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "literature_review_skill",
    };
  }
  if (params.request.classifiedIntent?.deliverableIntent === "document") {
    const documentKind =
      params.request.classifiedIntent.documentKind || "custom";
    return {
      required: true,
      documentKind,
      integrityPolicy:
        documentKind === "literature_review" ? "research_grounded" : "authored",
      trigger:
        documentKind === "literature_review"
          ? "literature_review_intent"
          : "document_intent",
    };
  }
  const explicitKind = inferExplicitDocumentKind(params.request.userText);
  if (explicitKind) {
    return {
      required: true,
      documentKind: explicitKind,
      integrityPolicy:
        explicitKind === "literature_review" ? "research_grounded" : "authored",
      trigger:
        explicitKind === "literature_review"
          ? "literature_review_intent"
          : "document_intent",
    };
  }
  return NO_DOCUMENT;
}
