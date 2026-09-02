import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentToolResult,
} from "../../types";
import {
  PlanDocumentFinalizer,
  type SubmitPlanDocumentInput,
} from "../../documents/finalizer";
import type {
  DocumentAssetProvenance,
  PlanCitationCluster,
  PlanCitationSource,
  PlanDocumentAsset,
} from "../../documents/types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, ok, validateObject } from "../shared";

type SubmitPlanDocumentResult = {
  documentId: string;
  contentHash: string;
  visibleMarkdown: string;
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function parseSource(value: unknown, label: string): PlanCitationSource {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? value.evidenceRefs.map((entry, index) =>
        requiredString(entry, `${label}.evidenceRefs[${index}]`),
      )
    : [];
  if (!evidenceRefs.length) {
    throw new Error(`${label}.evidenceRefs must contain trusted evidence IDs`);
  }
  let locator: PlanCitationSource["locator"];
  if (value.locator !== undefined) {
    if (!validateObject<Record<string, unknown>>(value.locator)) {
      throw new Error(`${label}.locator must be an object`);
    }
    if (value.locator.kind !== "pdf_page") {
      throw new Error(`${label}.locator.kind must be pdf_page`);
    }
    locator = {
      kind: "pdf_page",
      attachmentItemKey: requiredString(
        value.locator.attachmentItemKey,
        `${label}.locator.attachmentItemKey`,
      ),
      pageIndex: nonNegativeInteger(
        value.locator.pageIndex,
        `${label}.locator.pageIndex`,
      ),
      sourceFingerprint: requiredString(
        value.locator.sourceFingerprint,
        `${label}.locator.sourceFingerprint`,
      ),
    };
  }
  return {
    libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
    itemKey: requiredString(value.itemKey, `${label}.itemKey`),
    evidenceRefs,
    ...(locator ? { locator } : {}),
  };
}

function parseCitation(value: unknown, index: number): PlanCitationCluster {
  const label = `citations[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(value.sources) || !value.sources.length) {
    throw new Error(`${label}.sources must not be empty`);
  }
  return {
    citationId: requiredString(value.citationId, `${label}.citationId`),
    sources: value.sources.map((source, sourceIndex) =>
      parseSource(source, `${label}.sources[${sourceIndex}]`),
    ),
  };
}

function parseQuote(
  value: unknown,
  index: number,
): SubmitPlanDocumentInput["quotes"][number] {
  const label = `quotes[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length) {
    throw new Error(`${label}.evidenceRefs must not be empty`);
  }
  return {
    quoteId: requiredString(value.quoteId, `${label}.quoteId`),
    text: requiredString(value.text, `${label}.text`),
    libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
    itemKey: requiredString(value.itemKey, `${label}.itemKey`),
    attachmentItemKey: requiredString(
      value.attachmentItemKey,
      `${label}.attachmentItemKey`,
    ),
    evidenceRefs: value.evidenceRefs.map((entry, evidenceIndex) =>
      requiredString(entry, `${label}.evidenceRefs[${evidenceIndex}]`),
    ),
  };
}

function parseAssetProvenance(
  value: unknown,
  label: string,
): DocumentAssetProvenance {
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.origin === "extracted") {
    return {
      origin: "extracted",
      libraryID: positiveInteger(value.libraryID, `${label}.libraryID`),
      itemKey: requiredString(value.itemKey, `${label}.itemKey`),
      attachmentItemKey: requiredString(
        value.attachmentItemKey,
        `${label}.attachmentItemKey`,
      ),
      sourceFingerprint: requiredString(
        value.sourceFingerprint,
        `${label}.sourceFingerprint`,
      ),
      pageIndex: nonNegativeInteger(value.pageIndex, `${label}.pageIndex`),
      extractionToolVersion: requiredString(
        value.extractionToolVersion,
        `${label}.extractionToolVersion`,
      ),
    };
  }
  if (value.origin === "generated") {
    if (!Array.isArray(value.evidenceRefs)) {
      throw new Error(`${label}.evidenceRefs must be an array`);
    }
    return {
      origin: "generated",
      generator: requiredString(value.generator, `${label}.generator`),
      generatorVersion: requiredString(
        value.generatorVersion,
        `${label}.generatorVersion`,
      ),
      evidenceRefs: value.evidenceRefs.map((entry, index) =>
        requiredString(entry, `${label}.evidenceRefs[${index}]`),
      ),
    };
  }
  throw new Error(`${label}.origin must be extracted or generated`);
}

function parseAsset(value: unknown, index: number): PlanDocumentAsset {
  const label = `assets[${index}]`;
  if (!validateObject<Record<string, unknown>>(value)) {
    throw new Error(`${label} must be an object`);
  }
  const optionalDimension = (entry: unknown, field: string) =>
    entry === undefined
      ? undefined
      : positiveInteger(entry, `${label}.${field}`);
  return {
    assetId: requiredString(value.assetId, `${label}.assetId`),
    contentHash: requiredString(value.contentHash, `${label}.contentHash`),
    mimeType: requiredString(value.mimeType, `${label}.mimeType`),
    byteLength: positiveInteger(value.byteLength, `${label}.byteLength`),
    width: optionalDimension(value.width, "width"),
    height: optionalDimension(value.height, "height"),
    caption: requiredString(value.caption, `${label}.caption`),
    durablePath: requiredString(value.durablePath, `${label}.durablePath`),
    provenance: parseAssetProvenance(value.provenance, `${label}.provenance`),
  };
}

function validateSubmitPlanDocument(
  args: unknown,
): AgentToolInputValidation<SubmitPlanDocumentInput> {
  try {
    if (!validateObject<Record<string, unknown>>(args)) {
      return fail("submit_plan_document expects an object");
    }
    if (
      !Array.isArray(args.citations) ||
      !Array.isArray(args.quotes) ||
      !Array.isArray(args.assets) ||
      !Array.isArray(args.groundingIssues)
    ) {
      return fail(
        "citations, quotes, assets, and groundingIssues must be arrays",
      );
    }
    if (
      args.groundingReviewed !== "passed" &&
      args.groundingReviewed !== "passed_with_limitations"
    ) {
      return fail("groundingReviewed must record the completed model review");
    }
    return ok({
      title: requiredString(args.title, "title"),
      markdown: requiredString(args.markdown, "markdown"),
      citations: args.citations.map(parseCitation),
      quotes: args.quotes.map(parseQuote),
      assets: args.assets.map(parseAsset),
      groundingReviewed: args.groundingReviewed,
      groundingIssues: args.groundingIssues.map((entry, index) =>
        requiredString(entry, `groundingIssues[${index}]`),
      ),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createSubmitPlanDocumentTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<SubmitPlanDocumentInput, SubmitPlanDocumentResult> {
  const finalizer = new PlanDocumentFinalizer(gateway);
  return {
    spec: {
      name: "submit_plan_document",
      description:
        "Finalize the approved formal document. Use internal [[cite:C1]] tokens in Markdown and provide their Zotero item/evidence mappings. This terminal tool resolves CSL citations, validates provenance and coverage, and publishes the exact finalized document as the visible answer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "markdown",
          "citations",
          "quotes",
          "assets",
          "groundingReviewed",
          "groundingIssues",
        ],
        properties: {
          title: { type: "string" },
          markdown: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["citationId", "sources"],
              properties: {
                citationId: { type: "string" },
                sources: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "itemKey", "evidenceRefs"],
                    properties: {
                      libraryID: { type: "number" },
                      itemKey: { type: "string" },
                      evidenceRefs: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string" },
                      },
                      locator: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "kind",
                          "attachmentItemKey",
                          "pageIndex",
                          "sourceFingerprint",
                        ],
                        properties: {
                          kind: { type: "string", enum: ["pdf_page"] },
                          attachmentItemKey: { type: "string" },
                          pageIndex: { type: "number" },
                          sourceFingerprint: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          quotes: {
            type: "array",
            description:
              "Strict direct-quote mappings for [[quote:Q1]] tokens. Use [] when the document has no direct quotations; the host verifies each quote against an open PDF.js source and persists the location certificate.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "quoteId",
                "text",
                "libraryID",
                "itemKey",
                "attachmentItemKey",
                "evidenceRefs",
              ],
              properties: {
                quoteId: { type: "string" },
                text: { type: "string" },
                libraryID: { type: "number" },
                itemKey: { type: "string" },
                attachmentItemKey: { type: "string" },
                evidenceRefs: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" },
                },
              },
            },
          },
          assets: {
            type: "array",
            description:
              "Trusted extracted or already-produced generated assets. Use [] when the document has no figures.",
            items: { type: "object", additionalProperties: true },
          },
          groundingReviewed: {
            type: "string",
            enum: ["passed", "passed_with_limitations"],
          },
          groundingIssues: {
            type: "array",
            items: { type: "string" },
            description:
              "Non-authoritative grounding-review concerns. Required to be non-empty when groundingReviewed is passed_with_limitations.",
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: false,
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
    guidance: {
      matches: (request) => request.planContext?.phase === "executing",
      instruction:
        "When the approved deliverable is a document, finish research and grounding review, then call submit_plan_document exactly once from the active document task. Write complete Markdown with the approved headings and a natural Scope and limitations section. Put [[cite:C1]] tokens at supported claims and map every token to frozen-corpus item keys and persisted evidence IDs. Use [[quote:Q1]] only for exact direct quotations and provide a quote mapping; the source PDF must be open so the host can issue a strict PDF.js location certificate. Record grounding review concerns in groundingIssues and disclose them in Scope and limitations. Do not hand-write References; the host generates them through Zotero CSL. Never place citation or quote tokens in prose outside this terminal submission.",
    },
    validate: validateSubmitPlanDocument,
    execute: async (input, context) => {
      const plan = context.request.planContext;
      if (!plan || plan.phase !== "executing") {
        throw new Error(
          "submit_plan_document is available only during approved execution",
        );
      }
      if (!plan.activeTaskId) {
        throw new Error("No active plan task can accept the document");
      }
      const { document } = await finalizer.finalize({
        executionId: plan.executionId,
        activeTaskId: plan.activeTaskId,
        input,
      });
      return {
        documentId: document.documentId,
        contentHash: document.contentHash,
        visibleMarkdown: document.visibleMarkdown,
      };
    },
    resolveTerminalResult: (_input, result: AgentToolResult) => {
      if (!validateObject<Record<string, unknown>>(result.content)) return null;
      const documentId =
        typeof result.content.documentId === "string"
          ? result.content.documentId
          : "";
      const finalText =
        typeof result.content.visibleMarkdown === "string"
          ? result.content.visibleMarkdown
          : "";
      if (!documentId || !finalText) return null;
      return {
        finalText,
        planDocumentId: documentId,
        providerTranscript: "tool_only",
      };
    },
  };
}
