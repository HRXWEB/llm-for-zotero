import { renderMarkdownForNote } from "../../utils/markdown";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  listTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "../plans/store";
import {
  listResearchCorpusItems,
  listResearchEvidence,
  listPaperFindings,
  listScopeSnapshotItems,
  loadResearchJobForExecution,
} from "../research/store";
import type {
  ResearchCorpusItem,
  ResearchEvidenceRecord,
} from "../research/types";
import { getResearchItemFingerprints } from "../research/scopeSnapshot";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  formatDocumentCitations,
  formatPlanDocumentCitations,
  type DocumentCitationEvidence,
} from "./citationService";
import {
  PLAN_DOCUMENT_ASSET_MAX_BYTES,
  PLAN_DOCUMENT_ASSETS_MAX_BYTES,
  PLAN_DOCUMENT_MARKDOWN_MAX_BYTES,
  type DocumentCoverageItem,
  type PlanCitationCluster,
  type PlanDocument,
  type PlanDocumentAsset,
  type PlanDocumentOutboxRecord,
  type PlanVerifiedQuote,
  getPlannedDocumentOrigin,
} from "./types";
import {
  listPlanDocumentOutboxForConversation,
  loadLatestPlanDocumentForExecution,
  loadLatestDocumentForRun,
  loadPlanDocument,
  loadPlanDocumentOutbox,
  markPlanDocumentDelivered,
  materializePlanDocumentAssets,
  nextPlanDocumentVersion,
  savePlanDocumentInTransaction,
} from "./store";
import type {
  PlanExecutionLedger,
  TaskEvidence,
  TrustedReadObservation,
} from "../plans/types";
import {
  assertTaskCompletionEvidence,
  planExecutionCoordinator,
} from "../plans/coordinator";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";

export type SubmitPlanDocumentInput = Readonly<{
  title: string;
  markdown: string;
  citations: readonly PlanCitationCluster[];
  quotes: readonly Readonly<{
    quoteId: string;
    text: string;
    libraryID: number;
    itemKey: string;
    attachmentItemKey: string;
    evidenceRefs: readonly string[];
  }>[];
  assets: readonly PlanDocumentAsset[];
  groundingReviewed: "passed" | "passed_with_limitations";
  groundingIssues: readonly string[];
}>;

const QUOTE_TOKEN = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

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

function validateSections(params: {
  markdown: string;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
}): void {
  const headings = collectHeadings(params.markdown);
  const required = params.requiredSections
    .map(normalizeHeading)
    .filter((heading) => heading !== "references");
  if (params.requiresCoverageSection) required.push("scope and limitations");
  const missing = [...new Set(required)].filter(
    (heading) => !headings.has(heading),
  );
  if (missing.length) {
    throw new Error(
      `Document is missing required sections: ${missing.join(", ")}`,
    );
  }
}

function validateVisibleDocumentPrivacy(markdown: string): void {
  if (
    /(?:file:\/\/|(?:^|[\s("'])\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\)/m.test(
      markdown,
    )
  ) {
    throw new Error(
      "Document Markdown contains a local filesystem path; use relative asset links or Zotero links",
    );
  }
}

function validateAssets(
  assets: readonly PlanDocumentAsset[],
  requireEvidence = true,
): void {
  let total = 0;
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(asset.assetId) ||
      asset.assetId.includes("..") ||
      ids.has(asset.assetId)
    ) {
      throw new Error(`Duplicate or empty document asset ID: ${asset.assetId}`);
    }
    ids.add(asset.assetId);
    if (!asset.contentHash.trim() || !asset.durablePath.trim()) {
      throw new Error(
        `Document asset ${asset.assetId} lacks durable provenance`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.contentHash)) {
      throw new Error(
        `Document asset ${asset.assetId} has an invalid content hash`,
      );
    }
    if (!/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/i.test(asset.mimeType)) {
      throw new Error(
        `Document asset ${asset.assetId} is not a supported figure`,
      );
    }
    if (
      !Number.isInteger(asset.width) ||
      Number(asset.width) <= 0 ||
      !Number.isInteger(asset.height) ||
      Number(asset.height) <= 0
    ) {
      throw new Error(`Document asset ${asset.assetId} requires dimensions`);
    }
    if (!asset.caption.trim()) {
      throw new Error(`Document asset ${asset.assetId} requires a caption`);
    }
    if (
      requireEvidence &&
      asset.provenance.origin === "generated" &&
      !asset.provenance.evidenceRefs.length
    ) {
      throw new Error(
        `Generated asset ${asset.assetId} requires evidence references`,
      );
    }
    if (
      asset.byteLength <= 0 ||
      asset.byteLength > PLAN_DOCUMENT_ASSET_MAX_BYTES
    ) {
      throw new Error(
        `Document asset ${asset.assetId} exceeds the 25 MiB limit`,
      );
    }
    total += asset.byteLength;
  }
  if (total > PLAN_DOCUMENT_ASSETS_MAX_BYTES) {
    throw new Error("Document assets exceed the 100 MiB per-document limit");
  }
}

function validateQuoteBoundary(markdown: string): void {
  const proseWithoutTokens = markdown.replace(QUOTE_TOKEN, "");
  const hasDirectQuote =
    /^\s*>\s+\S/m.test(proseWithoutTokens) ||
    /(?:^|[\s(])["“][^"”\n]{20,}["”]/m.test(proseWithoutTokens);
  if (hasDirectQuote) {
    throw new Error(
      "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
    );
  }
}

async function resolveVerifiedQuotes(params: {
  markdown: string;
  quotes: SubmitPlanDocumentInput["quotes"];
  corpusKeys: ReadonlySet<string>;
  evidenceByRef: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof listResearchEvidence>>[number]
  >;
}): Promise<{ markdown: string; verifiedQuotes: PlanVerifiedQuote[] }> {
  validateQuoteBoundary(params.markdown);
  const mappings = new Map<string, SubmitPlanDocumentInput["quotes"][number]>();
  for (const quote of params.quotes) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(quote.quoteId) ||
      mappings.has(quote.quoteId)
    ) {
      throw new Error(`Duplicate or invalid quote ID: ${quote.quoteId}`);
    }
    mappings.set(quote.quoteId, quote);
  }
  const tokenIds = [...params.markdown.matchAll(QUOTE_TOKEN)].map(
    (match) => match[1],
  );
  if (new Set(tokenIds).size !== tokenIds.length) {
    throw new Error("Each verified quote token may appear only once");
  }
  for (const quoteId of tokenIds) {
    if (!mappings.has(quoteId)) {
      throw new Error(`Document contains unresolved quote token ${quoteId}`);
    }
  }
  for (const quoteId of mappings.keys()) {
    if (!tokenIds.includes(quoteId)) {
      throw new Error(`Quote ${quoteId} is not used in the document`);
    }
  }
  if (!mappings.size) return { markdown: params.markdown, verifiedQuotes: [] };

  const [{ getAllOpenReaders }, { verifyCompleteQuoteInLivePdfJs }] =
    await Promise.all([
      import("../../modules/contextPanel/contextResolution"),
      import("../../modules/contextPanel/livePdfSelectionLocator"),
    ]);
  const readers = new Map<number, unknown>();
  for (const reader of getAllOpenReaders()) {
    const itemId = Math.floor(Number(reader?._item?.id || reader?.itemID || 0));
    if (itemId && !readers.has(itemId)) readers.set(itemId, reader);
  }
  const verifiedQuotes: PlanVerifiedQuote[] = [];
  for (const quoteId of tokenIds) {
    const quote = mappings.get(quoteId)!;
    const identity = `${quote.libraryID}:${quote.itemKey}`;
    if (!params.corpusKeys.has(identity)) {
      throw new Error(`Quote ${quoteId} references an item outside the corpus`);
    }
    if (!quote.evidenceRefs.length) {
      throw new Error(`Quote ${quoteId} requires trusted research evidence`);
    }
    const paper = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.itemKey,
    );
    const attachment = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.attachmentItemKey,
    );
    if (
      !paper ||
      paper.deleted ||
      !attachment ||
      attachment.deleted ||
      !attachment.isAttachment?.() ||
      Number(attachment.parentID || 0) !== Number(paper.id)
    ) {
      throw new Error(
        `Quote ${quoteId} has an invalid PDF attachment identity`,
      );
    }
    const evidence = quote.evidenceRefs.map((reference) => {
      const record = params.evidenceByRef.get(reference);
      if (
        !record ||
        record.libraryID !== quote.libraryID ||
        record.itemKey !== quote.itemKey ||
        !["body", "quote"].includes(record.sourceKind) ||
        record.locator?.attachmentItemKey !== quote.attachmentItemKey
      ) {
        throw new Error(`Quote ${quoteId} has an invalid evidence reference`);
      }
      return record;
    });
    const reader = readers.get(Number(attachment.id));
    if (!reader) {
      throw new Error(
        `Quote ${quoteId} requires the source PDF to be open for strict PDF.js verification`,
      );
    }
    const verification = await verifyCompleteQuoteInLivePdfJs(
      reader,
      Number(attachment.id),
      quote.text,
    );
    if (verification.status !== "matched") {
      throw new Error(
        `Quote ${quoteId} failed strict PDF.js verification: ${verification.status === "defer" ? verification.reason : "the literal wording was not found"}`,
      );
    }
    if (
      !evidence.some(
        (record) =>
          record.locator?.pageIndex === verification.certificate.pageIndex,
      )
    ) {
      throw new Error(
        `Quote ${quoteId} is not backed by trusted evidence on its verified PDF page`,
      );
    }
    verifiedQuotes.push({
      quoteId,
      text: quote.text,
      libraryID: quote.libraryID,
      itemKey: quote.itemKey,
      attachmentItemKey: quote.attachmentItemKey,
      evidenceRefs: [...quote.evidenceRefs],
      certificate: {
        contextItemId: verification.certificate.contextItemId,
        sourceFingerprint: `pdfjs:${verification.certificate.documentFingerprint}`,
        pageIndex: verification.certificate.pageIndex,
        sourceMatchText: verification.certificate.sourceMatchText,
        sourceMatchKind: verification.certificate.sourceMatchKind,
        sourceMatchPageOccurrence:
          verification.certificate.sourceMatchPageOccurrence,
      },
    });
  }
  const quotesById = new Map(
    verifiedQuotes.map((quote) => [quote.quoteId, quote]),
  );
  return {
    markdown: params.markdown.replace(QUOTE_TOKEN, (_token, quoteId: string) =>
      quotesById
        .get(quoteId)!
        .text.split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    ),
    verifiedQuotes,
  };
}

function coverageItem(
  item: ResearchCorpusItem,
  evidence: readonly ResearchEvidenceRecord[],
): DocumentCoverageItem {
  const liveItem = Zotero.Items.getByLibraryAndKey(
    item.libraryID,
    item.itemKey,
  );
  const title = liveItem
    ? String(liveItem.getField?.("title") || "").trim() || undefined
    : undefined;
  const status =
    item.screeningStatus === "included"
      ? "included"
      : item.screeningStatus === "excluded"
        ? "excluded"
        : item.screeningStatus === "unreadable"
          ? "unreadable"
          : item.screeningStatus === "missing"
            ? "missing"
            : "unresolved";
  return {
    libraryID: item.libraryID,
    itemKey: item.itemKey,
    title,
    status,
    reason: item.decisionReason,
    evidenceDepth: (() => {
      const kinds = evidence
        .filter(
          (entry) =>
            entry.libraryID === item.libraryID &&
            entry.itemKey === item.itemKey &&
            entry.version === 2 &&
            Boolean(entry.observationId),
        )
        .map((entry) => entry.sourceKind);
      if (kinds.some((kind) => ["body", "figure", "quote"].includes(kind))) {
        return "body";
      }
      if (kinds.includes("abstract")) return "abstract";
      if (kinds.includes("metadata")) return "metadata";
      return "none";
    })(),
  };
}

function addEvidenceToLedger(
  ledger: PlanExecutionLedger,
  evidence: readonly TaskEvidence[],
): PlanExecutionLedger {
  const evidenceByTask = new Map<string, string[]>();
  for (const entry of evidence) {
    const ids = evidenceByTask.get(entry.taskId) || [];
    ids.push(entry.evidenceId);
    evidenceByTask.set(entry.taskId, ids);
  }
  return {
    ...ledger,
    tasks: ledger.tasks.map((task) => {
      const ids = evidenceByTask.get(task.taskId);
      if (!ids?.length) return task;
      return {
        ...task,
        evidenceIds: [...new Set([...task.evidenceIds, ...ids])],
        updatedAt: Math.max(...evidence.map((entry) => entry.createdAt)),
      };
    }),
    updatedAt: Math.max(...evidence.map((entry) => entry.createdAt)),
  };
}

async function assertPlanDocumentPredecessorsComplete(
  ledger: PlanExecutionLedger,
  documentTaskId: string,
): Promise<void> {
  const otherTasks = ledger.tasks.filter(
    (entry) => entry.taskId !== documentTaskId,
  );
  const unresolvedTasks = otherTasks.filter(
    (entry) =>
      entry.status !== "completed" &&
      !(entry.kind === "required_step" && entry.status === "skipped") &&
      !(entry.kind === "supporting_child" && entry.status === "cancelled"),
  );
  if (unresolvedTasks.length) {
    throw new Error(
      "The formal document must be the final active plan task after all other approved work is verified complete",
    );
  }
  for (const completedTask of otherTasks.filter(
    (entry) => entry.status === "completed",
  )) {
    assertTaskCompletionEvidence(
      completedTask,
      await listTaskEvidence(ledger.executionId, completedTask.taskId),
    );
  }
}

export class PlanDocumentFinalizer {
  constructor(private readonly gateway: ZoteroGateway) {}

  async finalize(params: {
    executionId: string;
    activeTaskId: string;
    input: SubmitPlanDocumentInput;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const now = params.now ?? Date.now();
    const ledger = await loadPlanExecutionLedger(params.executionId);
    if (!ledger) throw new Error("Plan execution ledger not found");
    const priorDocument = await loadLatestPlanDocumentForExecution(
      params.executionId,
    );
    if (priorDocument) {
      const priorOrigin = getPlannedDocumentOrigin(priorDocument);
      if (
        !priorOrigin ||
        priorOrigin.executionId !== ledger.executionId ||
        priorOrigin.parentTaskId !== params.activeTaskId
      ) {
        throw new Error(
          "The prior document does not belong to the active Plan task",
        );
      }
      await assertPlanDocumentPredecessorsComplete(ledger, params.activeTaskId);
      const priorOutbox = await loadPlanDocumentOutbox(
        priorDocument.documentId,
      );
      if (!priorOutbox) {
        throw new Error(
          "The finalized document exists without its durable outbox",
        );
      }
      return { document: priorDocument, outbox: priorOutbox };
    }
    if (ledger.activeTaskId !== params.activeTaskId) {
      throw new Error(
        "Document finalization must belong to the active plan task",
      );
    }
    const task = ledger.tasks.find(
      (entry) => entry.taskId === params.activeTaskId,
    );
    if (!task) throw new Error("Document plan task not found");
    const integrityRequirement = task.completionRequirements?.find(
      (requirement) => requirement.kind === "document_integrity",
    );
    const publishRequirement = task.completionRequirements?.find(
      (requirement) => requirement.kind === "document_published",
    );
    if (!integrityRequirement || !publishRequirement) {
      throw new Error("The active task does not authorize a formal document");
    }
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (
      !artifact ||
      artifact.digest !== ledger.planDigest ||
      artifact.contract?.deliverable.kind !== "document" ||
      !artifact.contractDigest
    ) {
      throw new Error(
        "The approved document contract is unavailable or changed",
      );
    }
    if (
      integrityRequirement.contractDigest !== artifact.contractDigest ||
      publishRequirement.contractDigest !== artifact.contractDigest
    ) {
      throw new Error(
        "Document requirements do not match the approved contract",
      );
    }
    const spec = artifact.contract.deliverable.spec;
    const title = params.input.title.trim();
    if (!title) throw new Error("Document title is required");
    if (title !== spec.title) {
      throw new Error(
        `Document title does not match the approved document spec. Expected exactly: ${JSON.stringify(spec.title)}`,
      );
    }
    if (!spec.allowFigures && params.input.assets.length) {
      throw new Error("The approved document spec does not allow figures");
    }
    if (utf8Bytes(params.input.markdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES) {
      throw new Error("Document Markdown exceeds the 2 MiB limit");
    }
    validateSections({
      markdown: params.input.markdown,
      requiredSections: spec.requiredSections,
      requiresCoverageSection: spec.requiresCoverageSection,
    });
    validateVisibleDocumentPrivacy(params.input.markdown);
    validateAssets(params.input.assets);
    if (
      params.input.groundingReviewed === "passed_with_limitations" &&
      !params.input.groundingIssues.length
    ) {
      throw new Error(
        "A grounding review with limitations must record the detected issues",
      );
    }

    const researchJob = await loadResearchJobForExecution(params.executionId);
    if (artifact.contract.investigation && !researchJob) {
      throw new Error(
        "Research document cannot finalize without a research job",
      );
    }
    if (
      researchJob &&
      (researchJob.status !== "completed" || !researchJob.coverageStatus)
    ) {
      throw new Error("Research coverage is not terminal yet");
    }
    await assertPlanDocumentPredecessorsComplete(ledger, task.taskId);
    const corpusSnapshot = artifact.contract.investigation?.scopeSnapshot
      ? await listScopeSnapshotItems(
          artifact.contract.investigation.scopeSnapshot.snapshotId,
        )
      : [];
    const researchEvidence = researchJob
      ? await listResearchEvidence(researchJob.researchJobId)
      : [];
    const paperFindings = researchJob
      ? await listPaperFindings(researchJob.researchJobId)
      : [];
    const liveFingerprints = new Map<
      string,
      Awaited<ReturnType<typeof getResearchItemFingerprints>>
    >();
    const fingerprintFor = async (libraryID: number, itemKey: string) => {
      const identity = `${libraryID}:${itemKey}`;
      const cached = liveFingerprints.get(identity);
      if (cached) return cached;
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item || item.deleted) {
        throw new Error(
          `Research source ${identity} is missing at finalization`,
        );
      }
      const fingerprints = await getResearchItemFingerprints(
        this.gateway,
        item.id,
      );
      liveFingerprints.set(identity, fingerprints);
      return fingerprints;
    };
    for (const evidence of researchEvidence) {
      const live = await fingerprintFor(evidence.libraryID, evidence.itemKey);
      const expected = ["body", "figure", "quote"].includes(evidence.sourceKind)
        ? live.attachmentFingerprint
        : live.metadataFingerprint;
      if (!expected || expected !== evidence.sourceFingerprint) {
        throw new Error(
          `Research evidence ${evidence.evidenceRef} changed after it was recorded`,
        );
      }
    }
    for (const finding of paperFindings) {
      const live = await fingerprintFor(finding.libraryID, finding.itemKey);
      if (
        finding.sourceFingerprint !== live.attachmentFingerprint &&
        finding.sourceFingerprint !== live.metadataFingerprint
      ) {
        throw new Error(
          `Paper finding ${finding.findingId} changed after it was recorded`,
        );
      }
    }
    const evidenceByRef = new Map(
      researchEvidence.map((entry) => [entry.evidenceRef, entry]),
    );
    const corpusKeys = new Set(
      corpusSnapshot.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const resolvedQuotes = await resolveVerifiedQuotes({
      markdown: params.input.markdown,
      quotes: params.input.quotes,
      corpusKeys,
      evidenceByRef,
    });
    validateVisibleDocumentPrivacy(resolvedQuotes.markdown);
    for (const asset of params.input.assets) {
      if (asset.provenance.origin === "generated") {
        if (
          asset.provenance.evidenceRefs.some(
            (reference) => !evidenceByRef.has(reference),
          )
        ) {
          throw new Error(
            `Generated asset ${asset.assetId} references unknown research evidence`,
          );
        }
        continue;
      }
      if (
        !corpusKeys.has(
          `${asset.provenance.libraryID}:${asset.provenance.itemKey}`,
        )
      ) {
        throw new Error(
          `Extracted asset ${asset.assetId} is outside the approved corpus`,
        );
      }
      const provenance = asset.provenance;
      const trusted = researchEvidence.some(
        (entry) =>
          entry.libraryID === provenance.libraryID &&
          entry.itemKey === provenance.itemKey &&
          entry.sourceKind === "figure" &&
          entry.locator?.sourceFingerprint === provenance.sourceFingerprint &&
          entry.locator?.attachmentItemKey === provenance.attachmentItemKey &&
          entry.locator?.pageIndex === provenance.pageIndex,
      );
      if (!trusted) {
        throw new Error(
          `Extracted asset ${asset.assetId} lacks trusted figure provenance`,
        );
      }
    }
    if (params.input.assets.length) {
      const taskEvidence = (
        await Promise.all(
          ledger.tasks.map((entry) =>
            listTaskEvidence(ledger.executionId, entry.taskId),
          ),
        )
      ).flat();
      const emittedArtifacts = taskEvidence
        .filter(
          (entry) => entry.verified && entry.payload?.type === "tool_artifacts",
        )
        .flatMap((entry) =>
          entry.payload?.type === "tool_artifacts"
            ? entry.payload.artifacts
            : [],
        );
      for (const asset of params.input.assets) {
        const expectedHash = asset.contentHash.replace(/^sha256:/, "");
        const trusted = emittedArtifacts.some(
          (artifact) =>
            artifact.kind === "image" &&
            artifact.storedPath === asset.durablePath &&
            artifact.mimeType === asset.mimeType &&
            (!artifact.contentHash ||
              artifact.contentHash.replace(/^sha256:/, "") === expectedHash),
        );
        if (!trusted) {
          throw new Error(
            `Document asset ${asset.assetId} was not emitted by a verified tool call in this execution`,
          );
        }
      }
    }
    const durableAssets = await materializePlanDocumentAssets(
      params.input.assets,
    );
    const formatted = formatPlanDocumentCitations({
      gateway: this.gateway,
      draftMarkdown: resolvedQuotes.markdown,
      clusters: params.input.citations,
      corpus: corpusSnapshot,
      evidence: researchEvidence,
      spec,
    });
    if (
      utf8Bytes(formatted.visibleMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES
    ) {
      throw new Error("Finalized document exceeds the 2 MiB limit");
    }
    const coverageItems = researchJob
      ? (
          await listResearchCorpusItems({
            researchJobId: researchJob.researchJobId,
          })
        ).map((item) => coverageItem(item, researchEvidence))
      : [];
    const validation: PlanDocument["validation"] = {
      integrityValidated: true,
      groundingReviewed: params.input.groundingReviewed,
      quoteVerified: resolvedQuotes.verifiedQuotes.length
        ? "verified"
        : "not_applicable",
      issues: [...params.input.groundingIssues],
    };
    const documentVersion = await nextPlanDocumentVersion({
      planId: artifact.planId,
      planRevision: artifact.revision,
    });
    const documentId = `${artifact.planId}:r${artifact.revision}:document:${documentVersion}`;
    const contentHash = `sha256:${await sha256Text(
      canonicalJson({
        title,
        markdown: formatted.visibleMarkdown,
        citations: formatted.citationBundle,
        verifiedQuotes: resolvedQuotes.verifiedQuotes,
        assets: durableAssets,
        coverageStatus: researchJob?.coverageStatus,
        coverageItems,
        validation,
      }),
    )}`;
    const document: PlanDocument = {
      version: 2,
      documentId,
      documentVersion,
      documentKind: spec.kind,
      integrityPolicy: artifact.contract.investigation
        ? "research_grounded"
        : "authored",
      origin: {
        kind: "planned",
        planId: artifact.planId,
        planRevision: artifact.revision,
        executionId: ledger.executionId,
        parentTaskId: task.taskId,
        contractDigest: artifact.contractDigest,
      },
      conversationKey: ledger.conversationKey,
      title,
      visibleMarkdown: formatted.visibleMarkdown,
      visibleHtml: renderMarkdownForNote(formatted.visibleMarkdown),
      citationBundle: formatted.citationBundle,
      verifiedQuotes: resolvedQuotes.verifiedQuotes,
      assets: durableAssets,
      coverageStatus: researchJob?.coverageStatus,
      coverageItems,
      validation,
      contentHash,
      createdAt: now,
    };
    const outbox: PlanDocumentOutboxRecord = {
      version: 1,
      outboxId: `${documentId}:message`,
      documentId,
      conversationKey: ledger.conversationKey,
      messageTimestamp: now,
      visibleMarkdown: document.visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const integrityEvidence: TaskEvidence = {
      version: 3,
      evidenceId: `${documentId}:integrity`,
      executionId: ledger.executionId,
      taskId: task.taskId,
      kind: "document_integrity",
      verified: true,
      requirementId: integrityRequirement.requirementId,
      criterionIds: integrityRequirement.criterionIds,
      contractDigest: integrityRequirement.contractDigest,
      payload: {
        type: "document_integrity",
        documentId: document.documentId,
        contentHash: document.contentHash,
        integrityValidated: true,
      },
      reference: document.contentHash,
      summary:
        "Document structure, citations, evidence links, and provenance passed deterministic integrity validation",
      createdAt: now,
    };
    await Zotero.DB.executeTransaction(async () => {
      await savePlanDocumentInTransaction({ document, outbox });
      await saveTaskEvidence(integrityEvidence);
      await savePlanExecutionLedger(
        addEvidenceToLedger(ledger, [integrityEvidence]),
        undefined,
        { alreadyInTransaction: true },
      );
    });
    return { document, outbox };
  }
}

function directDocumentSpec(params: {
  request: AgentRuntimeRequest;
  title: string;
  hasCitations: boolean;
}) {
  const policy = params.request.documentOutcomePolicy;
  if (!policy?.required)
    throw new Error("This turn does not require a document");
  const researchGrounded = policy.integrityPolicy === "research_grounded";
  return {
    kind: policy.documentKind,
    title: params.title,
    requiredSections: researchGrounded ? ["Scope and limitations"] : [],
    requiresReferences: researchGrounded || params.hasCitations,
    requiresCoverageSection: researchGrounded,
    allowFigures: true,
    citationStyle: {
      styleId: "http://www.zotero.org/styles/apa",
      styleTitle: "APA",
      locale: params.request.classifiedIntent?.queryLanguage || "en-US",
    },
  } as const;
}

function evidenceFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCitationEvidence[] {
  return observations.map((observation) => ({
    version: 2,
    evidenceRef: observation.observationId,
    observationId: observation.observationId,
    libraryID: observation.libraryID,
    itemKey: observation.itemKey,
    locator:
      observation.attachmentItemKey &&
      observation.pageIndex !== undefined &&
      observation.sourceFingerprint
        ? {
            kind: "pdf_page",
            attachmentItemKey: observation.attachmentItemKey,
            pageIndex: observation.pageIndex,
            sourceFingerprint: observation.sourceFingerprint,
          }
        : undefined,
  }));
}

function coverageFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCoverageItem[] {
  const byItem = new Map<string, DocumentCoverageItem>();
  for (const observation of observations) {
    const key = `${observation.libraryID}:${observation.itemKey}`;
    const item =
      Zotero.Items.getByLibraryAndKey(
        observation.libraryID,
        observation.itemKey,
      ) || null;
    const depth = observation.capabilities.includes("body")
      ? "body"
      : observation.capabilities.includes("abstract")
        ? "abstract"
        : observation.capabilities.includes("metadata")
          ? "metadata"
          : "none";
    const prior = byItem.get(key);
    const rank = { none: 0, metadata: 1, abstract: 2, body: 3 } as const;
    if (prior && rank[prior.evidenceDepth] >= rank[depth]) continue;
    byItem.set(key, {
      libraryID: observation.libraryID,
      itemKey: observation.itemKey,
      title:
        String(
          item?.getField?.("title") || item?.getDisplayTitle?.() || "",
        ).trim() || undefined,
      status: "included",
      evidenceDepth: depth,
    });
  }
  return [...byItem.values()];
}

function normalizeAssetHash(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
}

function validateDirectAssetProvenance(params: {
  assets: readonly PlanDocumentAsset[];
  artifacts: readonly AgentToolArtifact[];
  observations: readonly TrustedReadObservation[];
  researchGrounded: boolean;
}): void {
  const observationIds = new Set(
    params.observations.map((entry) => entry.observationId),
  );
  for (const asset of params.assets) {
    const artifact = params.artifacts.find(
      (entry) =>
        entry.kind === "image" &&
        entry.storedPath === asset.durablePath &&
        entry.mimeType.toLowerCase() === asset.mimeType.toLowerCase() &&
        (!entry.contentHash ||
          normalizeAssetHash(entry.contentHash) ===
            normalizeAssetHash(asset.contentHash)),
    );
    if (!artifact) {
      throw new Error(
        `Document asset ${asset.assetId} was not emitted by a successful host tool call`,
      );
    }
    if (asset.provenance.origin === "generated") {
      if (
        params.researchGrounded &&
        asset.provenance.evidenceRefs.some((ref) => !observationIds.has(ref))
      ) {
        throw new Error(
          `Generated asset ${asset.assetId} has an invalid evidence reference`,
        );
      }
      continue;
    }
    const provenance = asset.provenance;
    const sourceObservation = params.observations.some(
      (entry) =>
        entry.libraryID === provenance.libraryID &&
        entry.itemKey === provenance.itemKey &&
        entry.attachmentItemKey === provenance.attachmentItemKey &&
        entry.sourceFingerprint === provenance.sourceFingerprint &&
        entry.pageIndex === provenance.pageIndex &&
        entry.capabilities.includes("figure"),
    );
    if (!sourceObservation) {
      throw new Error(
        `Extracted asset ${asset.assetId} is not backed by a host-verified figure observation`,
      );
    }
  }
}

export class DirectDocumentFinalizer {
  constructor(private readonly gateway: ZoteroGateway) {}

  async finalize(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const policy = params.request.documentOutcomePolicy;
    if (
      !policy?.required ||
      params.request.planContext?.phase === "executing"
    ) {
      throw new Error("Direct document finalization is not authorized");
    }
    const prior = await loadLatestDocumentForRun(params.runId);
    if (prior) {
      const priorOutbox = await loadPlanDocumentOutbox(prior.documentId);
      if (!priorOutbox)
        throw new Error("The document exists without its outbox");
      return { document: prior, outbox: priorOutbox };
    }
    const now = params.now ?? Date.now();
    const title = params.input.title.trim();
    if (!title) throw new Error("Document title is required");
    if (utf8Bytes(params.input.markdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES) {
      throw new Error("Document Markdown exceeds the 2 MiB limit");
    }
    const observations = params.request.documentReadObservations || [];
    const researchGrounded = policy.integrityPolicy === "research_grounded";
    if (
      researchGrounded &&
      !observations.some((entry) =>
        entry.capabilities.some((capability) =>
          ["abstract", "body", "figure", "quote"].includes(capability),
        ),
      )
    ) {
      throw new Error(
        "A literature-review document requires host-verified abstract or body evidence",
      );
    }
    if (researchGrounded && !params.input.citations.length) {
      throw new Error(
        "A literature-review document requires grounded citations",
      );
    }
    const spec = directDocumentSpec({
      request: params.request,
      title,
      hasCitations: params.input.citations.length > 0,
    });
    validateSections({
      markdown: params.input.markdown,
      requiredSections: spec.requiredSections,
      requiresCoverageSection: spec.requiresCoverageSection,
    });
    if (
      !researchGrounded &&
      collectHeadings(params.input.markdown).size === 0
    ) {
      throw new Error("A document must contain at least one Markdown heading");
    }
    validateVisibleDocumentPrivacy(params.input.markdown);
    validateAssets(params.input.assets, researchGrounded);
    validateDirectAssetProvenance({
      assets: params.input.assets,
      artifacts: params.request.documentArtifactObservations || [],
      observations,
      researchGrounded,
    });
    if (
      params.input.groundingReviewed === "passed_with_limitations" &&
      !params.input.groundingIssues.length
    ) {
      throw new Error(
        "A grounding review with limitations must record the detected issues",
      );
    }
    if (params.input.quotes.length) {
      throw new Error(
        "Direct document quote mappings are not yet supported; paraphrase with a grounded citation instead",
      );
    }
    const evidence = evidenceFromObservations(observations);
    const corpus = researchGrounded
      ? coverageFromObservations(observations)
      : params.input.citations.flatMap((cluster) => cluster.sources);
    const formatted = formatDocumentCitations({
      gateway: this.gateway,
      draftMarkdown: params.input.markdown,
      clusters: params.input.citations,
      corpus,
      evidence,
      spec,
      requireEvidence: researchGrounded,
    });
    const durableAssets = await materializePlanDocumentAssets(
      params.input.assets,
    );
    const coverageItems = researchGrounded
      ? coverageFromObservations(observations)
      : [];
    const validation: PlanDocument["validation"] = {
      integrityValidated: true,
      groundingReviewed: researchGrounded
        ? params.input.groundingReviewed
        : "not_run",
      quoteVerified: "not_applicable",
      issues: [...params.input.groundingIssues],
    };
    const documentId = `${params.runId}:document:1`;
    const contentHash = `sha256:${await sha256Text(
      canonicalJson({
        title,
        markdown: formatted.visibleMarkdown,
        citations: formatted.citationBundle,
        assets: durableAssets,
        coverageItems,
        validation,
      }),
    )}`;
    const document: PlanDocument = {
      version: 2,
      documentId,
      documentVersion: 1,
      documentKind: policy.documentKind,
      integrityPolicy: policy.integrityPolicy,
      origin: {
        kind: "direct",
        runId: params.runId,
        sourceMessageTimestamp:
          Number(params.request.metadata?.sourceMessageTimestamp) || now,
        routingReceipt: params.request.skillRoutingReceipt,
        skillRoutingReceiptHash:
          params.request.skillRoutingReceipt?.routerIdentityHash,
      },
      conversationKey: params.request.conversationKey,
      title,
      visibleMarkdown: formatted.visibleMarkdown,
      visibleHtml: renderMarkdownForNote(formatted.visibleMarkdown),
      citationBundle: formatted.citationBundle,
      verifiedQuotes: [],
      assets: durableAssets,
      coverageStatus: researchGrounded ? "partial" : undefined,
      coverageItems,
      validation,
      contentHash,
      createdAt: now,
    };
    const outbox: PlanDocumentOutboxRecord = {
      version: 1,
      outboxId: `${documentId}:message`,
      documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: now,
      visibleMarkdown: document.visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await Zotero.DB.executeTransaction(async () => {
      await savePlanDocumentInTransaction({ document, outbox });
    });
    return { document, outbox };
  }
}

export async function attachPublishedDocumentEvidence(params: {
  document: PlanDocument;
  deliveredAt?: number;
  messageTimestamp?: number;
  alreadyInTransaction?: boolean;
}): Promise<PlanExecutionLedger> {
  const now = params.deliveredAt ?? Date.now();
  const origin = getPlannedDocumentOrigin(params.document);
  if (!origin) {
    throw new Error("Direct documents do not have Plan publication evidence");
  }
  const ledger = await loadPlanExecutionLedger(origin.executionId);
  if (!ledger) throw new Error("Plan execution ledger not found");
  const task = ledger.tasks.find(
    (entry) => entry.taskId === origin.parentTaskId,
  );
  const requirement = task?.completionRequirements?.find(
    (entry) => entry.kind === "document_published",
  );
  if (!task || !requirement) {
    throw new Error("Document publication requirement not found");
  }
  const evidence: TaskEvidence = {
    version: 3,
    evidenceId: `${params.document.documentId}:published`,
    executionId: ledger.executionId,
    taskId: task.taskId,
    kind: "document_published",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "document_published",
      documentId: params.document.documentId,
      contentHash: params.document.contentHash,
      messageTimestamp: params.messageTimestamp ?? now,
    },
    reference: params.document.contentHash,
    summary:
      "The exact finalized document was persisted as the visible assistant message",
    createdAt: now,
  };
  const existing = await listTaskEvidence(ledger.executionId, task.taskId);
  if (!existing.some((entry) => entry.evidenceId === evidence.evidenceId)) {
    await saveTaskEvidence(evidence);
  }
  const updated = addEvidenceToLedger(ledger, [evidence]);
  await savePlanExecutionLedger(updated, undefined, {
    alreadyInTransaction: params.alreadyInTransaction,
  });
  return updated;
}

/**
 * Completes the durable outbox only after the ordinary conversation store has
 * persisted the exact visible assistant text. Repeated calls are idempotent.
 */
export async function deliverPendingPlanDocumentMessage(params: {
  conversationKey: number;
  visibleMarkdown: string;
  messageTimestamp: number;
  documentId?: string;
}): Promise<PlanDocument | null> {
  const candidates = (
    await listPlanDocumentOutboxForConversation(params.conversationKey)
  ).sort((left, right) => {
    if (params.documentId) return 0;
    const leftTimestamp = Math.abs(
      left.messageTimestamp - params.messageTimestamp,
    );
    const rightTimestamp = Math.abs(
      right.messageTimestamp - params.messageTimestamp,
    );
    return leftTimestamp - rightTimestamp;
  });
  const outbox = candidates.find(
    (entry) =>
      entry.visibleMarkdown === params.visibleMarkdown &&
      (!params.documentId || entry.documentId === params.documentId),
  );
  if (!outbox) return null;
  const document = await loadPlanDocument(outbox.documentId);
  if (
    !document ||
    document.visibleMarkdown !== params.visibleMarkdown ||
    document.visibleMarkdown !== outbox.visibleMarkdown
  ) {
    throw new Error(
      "Pending document does not match the persisted assistant message",
    );
  }
  const origin = getPlannedDocumentOrigin(document);
  if (outbox.status === "delivered") {
    // Recover histories produced before delivery and the terminal task
    // transition became one transaction. A crash in that old gap left the
    // document visible while its progress ledger remained non-terminal.
    if (origin) {
      const ledger = await loadPlanExecutionLedger(origin.executionId);
      const task = ledger?.tasks.find(
        (entry) => entry.taskId === origin.parentTaskId,
      );
      if (task?.status === "in_progress") {
        await planExecutionCoordinator.requestTransition({
          executionId: origin.executionId,
          taskId: origin.parentTaskId,
          toStatus: "completed",
          evidenceIds: task.evidenceIds,
          requestedBy: "host",
        });
      }
    }
    return document;
  }
  if (outbox.status !== "pending") return null;
  await Zotero.DB.executeTransaction(async () => {
    await markPlanDocumentDelivered({
      documentId: document.documentId,
      deliveredAt: Date.now(),
      messageTimestamp: params.messageTimestamp,
    });
    if (origin) {
      await attachPublishedDocumentEvidence({
        document,
        messageTimestamp: params.messageTimestamp,
        alreadyInTransaction: true,
      });
      const ledger = await loadPlanExecutionLedger(origin.executionId);
      const task = ledger?.tasks.find(
        (entry) => entry.taskId === origin.parentTaskId,
      );
      if (task?.status === "in_progress") {
        await planExecutionCoordinator.requestTransition(
          {
            executionId: origin.executionId,
            taskId: origin.parentTaskId,
            toStatus: "completed",
            evidenceIds: task.evidenceIds,
            requestedBy: "host",
          },
          Date.now(),
          { alreadyInTransaction: true },
        );
      }
    }
  });
  return document;
}
