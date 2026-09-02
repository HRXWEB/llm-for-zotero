import { assert } from "chai";
import { formatPlanDocumentCitations } from "../src/agent/documents/citationService";
import { renderMarkdownForNote } from "../src/utils/markdown";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { ResearchEvidenceRecord } from "../src/agent/research/types";

describe("plan document citation serialization", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;

  before(function () {
    const items = new Map([
      ["AAAA1111", { id: 10, isNote: () => false }],
      ["BBBB2222", { id: 11, isNote: () => false }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: {
        getByLibraryAndKey: (_libraryID: number, itemKey: string) =>
          items.get(itemKey) || false,
      },
    };
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  it("keeps exact CSL cluster text and appends ordered stable source links", function () {
    const evidence: ResearchEvidenceRecord[] = [
      {
        version: 2,
        evidenceRef: "e-a",
        researchJobId: "research",
        executionId: "execution",
        parentTaskId: "task",
        libraryID: 1,
        itemKey: "AAAA1111",
        sourceFingerprint: "pdfjs:a",
        sourceKind: "body",
        observationId: "observation-a",
        locator: {
          kind: "pdf_page",
          attachmentItemKey: "PDFP1111",
          pageIndex: 4,
          sourceFingerprint: "pdfjs:a",
        },
        createdAt: 1,
      },
      {
        version: 2,
        evidenceRef: "e-b",
        researchJobId: "research",
        executionId: "execution",
        parentTaskId: "task",
        libraryID: 1,
        itemKey: "BBBB2222",
        sourceFingerprint: "metadata:b",
        sourceKind: "metadata",
        observationId: "observation-b",
        createdAt: 1,
      },
    ];
    const result = formatPlanDocumentCitations({
      gateway: {
        formatStructuredCitations: () => ({
          clusters: [
            {
              citationId: "cluster",
              text: "(Alpha, 2020; Beta, 2021)",
              html: "<span>(Alpha, 2020; Beta, 2021)</span>",
            },
          ],
          bibliographyEntries: [
            { itemId: 10, text: "Alpha. 2020.", html: "Alpha. 2020." },
            { itemId: 11, text: "Beta. 2021.", html: "Beta. 2021." },
          ],
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
        }),
      } as unknown as ZoteroGateway,
      draftMarkdown: "## Findings\n\nResult [[cite:cluster]].",
      clusters: [
        {
          citationId: "cluster",
          sources: [
            {
              libraryID: 1,
              itemKey: "AAAA1111",
              evidenceRefs: ["e-a"],
              locator: {
                kind: "pdf_page",
                attachmentItemKey: "PDFP1111",
                pageIndex: 4,
                sourceFingerprint: "pdfjs:a",
              },
            },
            {
              libraryID: 1,
              itemKey: "BBBB2222",
              evidenceRefs: ["e-b"],
            },
          ],
        },
      ],
      corpus: [
        { snapshotId: "s", libraryID: 1, itemKey: "AAAA1111", ordinal: 0 },
        { snapshotId: "s", libraryID: 1, itemKey: "BBBB2222", ordinal: 1 },
      ],
      evidence,
      spec: {
        kind: "literature_review",
        title: "Review",
        requiredSections: ["Findings"],
        requiresReferences: true,
        requiresCoverageSection: false,
        allowFigures: false,
        citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
      },
    });

    const citation =
      "(Alpha, 2020; Beta, 2021) " +
      "[1](zotero://open-pdf/library/items/PDFP1111?page=5) " +
      "[2](zotero://select/library/items/BBBB2222)";
    assert.include(result.visibleMarkdown, citation);
    assert.equal(
      result.citationBundle.clusters[0].text,
      "(Alpha, 2020; Beta, 2021)",
    );
    assert.deepEqual(
      result.citationBundle.clusters[0].sources.map((source) => source.itemKey),
      ["AAAA1111", "BBBB2222"],
    );
    const noteHtml = renderMarkdownForNote(result.visibleMarkdown);
    assert.include(
      noteHtml,
      'href="zotero://open-pdf/library/items/PDFP1111?page=5"',
    );
    assert.include(noteHtml, 'href="zotero://select/library/items/BBBB2222"');
  });
});
