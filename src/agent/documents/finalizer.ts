import { renderMarkdownForNote } from "../../utils/markdown";
import { updatePlanTask } from "../plans/taskUpdates";
import type { TaskEvidence } from "../plans/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  formatDocumentCitations,
  type DocumentCitationEvidence,
} from "./citationService";
import { assertDocumentDraftValid, collectHeadings } from "./draftValidation";
import {
  utf8Bytes,
  validateAssets,
  validateVisibleDocumentPrivacy,
} from "./finalizationValidation";
import {
  materializePlanDocumentAssets,
  savePlanDocumentInTransaction,
} from "./store";
import {
  PLAN_DOCUMENT_MARKDOWN_MAX_BYTES,
  type DocumentArtifactV2,
  type DocumentSpec,
  type PlanDocumentOutboxRecord,
  type SubmitPlanDocumentInput,
} from "./types";
import { resolveVerifiedQuotes } from "./verifiedQuotes";

type DocumentFinalizationContext = Pick<
  DocumentArtifactV2,
  | "documentId"
  | "documentVersion"
  | "conversationKey"
  | "origin"
  | "integrityPolicy"
  | "coverageStatus"
  | "coverageItems"
> & {
  spec: DocumentSpec;
  corpus: readonly { libraryID: number; itemKey: string }[];
  evidence: readonly DocumentCitationEvidence[];
  quoteCorpusKeys: ReadonlySet<string>;
  /** Source owners attest figures against their native observations or research ledger. */
  validateAssetProvenance: () => void | Promise<void>;
};

type FinalizedDocument = {
  document: DocumentArtifactV2;
  outbox: PlanDocumentOutboxRecord;
};

/** One integrity pipeline for every origin; source acquisition stays with its owner. */
export async function finalizeDocument(params: {
  gateway: ZoteroGateway;
  input: SubmitPlanDocumentInput;
  context: DocumentFinalizationContext;
  now: number;
}): Promise<FinalizedDocument> {
  const { input, context, now } = params;
  const { spec, origin } = context;
  const planned = origin.kind === "planned";
  const researchGrounded = context.integrityPolicy === "research_grounded";
  // Plans retain their approved evidence requirements, including authored plans.
  const requireEvidence = planned || researchGrounded;
  const title = input.title.trim();
  if (!title) throw new Error("Document title is required");
  if (title !== spec.title)
    throw new Error(
      `Document title does not match the approved document spec. Expected exactly: ${JSON.stringify(spec.title)}`,
    );
  if (!spec.allowFigures && input.assets.length)
    throw new Error("The approved document spec does not allow figures");
  if (utf8Bytes(input.markdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new Error("Document Markdown exceeds the 2 MiB limit");
  assertDocumentDraftValid({
    markdown: input.markdown,
    requiredSections: spec.requiredSections,
    requiresCoverageSection: spec.requiresCoverageSection,
    validateQuotes: planned,
  });
  if (
    !planned &&
    !researchGrounded &&
    collectHeadings(input.markdown).size === 0
  )
    throw new Error("A document must contain at least one Markdown heading");
  validateVisibleDocumentPrivacy(input.markdown);
  validateAssets(input.assets, requireEvidence);
  if (
    input.groundingReviewed === "passed_with_limitations" &&
    !input.groundingIssues.length
  )
    throw new Error(
      "A grounding review with limitations must record the detected issues",
    );
  const resolvedQuotes = await resolveVerifiedQuotes({
    markdown: input.markdown,
    quotes: input.quotes,
    corpusKeys: context.quoteCorpusKeys,
    evidenceByRef: new Map(
      context.evidence.map((entry) => [entry.evidenceRef, entry]),
    ),
  });
  validateVisibleDocumentPrivacy(resolvedQuotes.markdown);
  await context.validateAssetProvenance();
  const formatted = await formatDocumentCitations({
    gateway: params.gateway,
    draftMarkdown: resolvedQuotes.markdown,
    clusters: input.citations,
    corpus: context.corpus,
    evidence: context.evidence,
    spec,
    requireEvidence,
  });
  if (utf8Bytes(formatted.visibleMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new Error("Finalized document exceeds the 2 MiB limit");
  // Check the complete visible payload before copying any assets or publishing it.
  const assets = await materializePlanDocumentAssets(input.assets);
  const validation: DocumentArtifactV2["validation"] = {
    integrityValidated: true,
    groundingReviewed: requireEvidence ? input.groundingReviewed : "not_run",
    quoteVerified: resolvedQuotes.verifiedQuotes.length
      ? "verified"
      : "not_applicable",
    issues: [...input.groundingIssues],
  };
  const contentHash = `sha256:${await sha256Text(
    canonicalJson({
      title,
      markdown: formatted.visibleMarkdown,
      citations: formatted.citationBundle,
      verifiedQuotes: resolvedQuotes.verifiedQuotes,
      assets,
      coverageItems: context.coverageItems,
      // Preserve the existing per-origin content identity for durable retries.
      ...(origin.kind === "planned"
        ? {
            coverageStatus: context.coverageStatus,
            scopeLineageDigest: origin.scopeLineageDigest,
          }
        : {}),
      validation,
    }),
  )}`;
  const document: DocumentArtifactV2 = {
    version: 2,
    documentId: context.documentId,
    documentVersion: context.documentVersion,
    documentKind: spec.kind,
    integrityPolicy: context.integrityPolicy,
    origin,
    conversationKey: context.conversationKey,
    title,
    visibleMarkdown: formatted.visibleMarkdown,
    visibleHtml: renderMarkdownForNote(formatted.visibleMarkdown),
    citationBundle: formatted.citationBundle,
    verifiedQuotes: resolvedQuotes.verifiedQuotes,
    assets,
    coverageStatus: context.coverageStatus,
    coverageItems: context.coverageItems,
    validation,
    contentHash,
    createdAt: now,
  };
  return {
    document,
    outbox: {
      version: 1,
      outboxId: `${document.documentId}:message`,
      documentId: document.documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: now,
      visibleMarkdown: document.visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Persist the document, pending outbox, and any Plan integrity evidence together. */
export async function persistFinalizedDocument(
  finalized: FinalizedDocument,
  evidence?: TaskEvidence,
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await savePlanDocumentInTransaction(finalized);
    if (evidence)
      await updatePlanTask({
        kind: "evidence",
        executionId: evidence.executionId,
        taskId: evidence.taskId,
        evidence: [evidence],
        now: evidence.createdAt,
        alreadyInTransaction: true,
      });
  });
}
