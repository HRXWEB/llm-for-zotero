import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { assert } from "chai";
import { savePlanDocumentAsNote } from "../src/agent/documents/actions";

/** Exercises the actual document decoder, save action and native note persistence boundary. */
describe("durable document note association", function () {
  const globals = globalThis as any;
  let original: any;
  let notes: Map<number, any>;
  let state: any;
  let failAssociation: boolean;
  let nextId: number;
  let inTransaction: boolean;
  let document: any;
  beforeEach(function () {
    original = globals.Zotero;
    notes = new Map();
    state = undefined;
    failAssociation = false;
    nextId = 100;
    inTransaction = false;
    document = {
      version: 2,
      documentId: "summary-document",
      documentVersion: 1,
      conversationKey: 42,
      documentKind: "custom",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: "summary-run",
        sourceMessageTimestamp: 1,
      },
      title: "Paper summary",
      visibleMarkdown: "# Summary\n\nExact durable summary.",
      visibleHtml: "<h1>Summary</h1><p>Exact durable summary.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      assets: [],
      verifiedQuotes: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:document-content",
      createdAt: 1,
    };
    class Note {
      id = 0;
      key = "";
      primaryLoaded = false;
      async loadPrimaryData() {
        this.primaryLoaded = true;
      }
      libraryID = 1;
      parentID?: number;
      deleted = false;
      html = "";
      stored = "";
      dateAdded = "2026-09-07 00:00:00";
      isNote() {
        return true;
      }
      isAttachment() {
        return false;
      }
      getNote() {
        return this.html;
      }
      setNote(html: string) {
        if (this.key && !this.primaryLoaded)
          throw new Error(
            "UnloadedDataException: primaryData not loaded for reserved key",
          );
        this.html = html;
      }
      getField(name: string) {
        return name === "title"
          ? "Summary"
          : name === "dateAdded"
            ? this.dateAdded
            : "";
      }
      getDisplayTitle() {
        return "Summary";
      }
      getNoteTitle() {
        return "Summary";
      }
      async saveTx() {
        return globals.Zotero.DB.executeTransaction(async () => {
          if (!this.id) {
            this.id = nextId++;
            this.key ||= `NOTE${this.id}`;
          }
          this.stored = this.html;
          notes.set(this.id, this);
          return this.id;
        });
      }
      async reload() {
        this.html = this.stored;
      }
    }
    const parent = {
      id: 42,
      key: "PAPER42",
      libraryID: 1,
      deleted: false,
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
    };
    globals.Zotero = {
      Utilities: { generateObjectKey: () => `NOTE${nextId}` },
      Item: Note,
      Libraries: { userLibraryID: 1 },
      Items: {
        get: (id: number) => (id === 42 ? parent : notes.get(id)),
        getByLibraryAndKey: (_lib: number, key: string) =>
          key === "PAPER42"
            ? parent
            : [...notes.values()].find((note) => note.key === key),
      },
      DB: {
        executeTransaction: async (callback: () => Promise<unknown>) => {
          if (inTransaction)
            throw new Error(
              "Nested Zotero transaction would wait on its owner",
            );
          inTransaction = true;
          const priorNotes = new Map(notes);
          const priorState = state;
          try {
            return await callback();
          } catch (error) {
            notes = priorNotes;
            state = priorState;
            throw error;
          } finally {
            inTransaction = false;
          }
        },
        queryAsync: async (sql: string, args: any[]) => {
          if (
            sql.includes(
              "INSERT OR REPLACE INTO llm_for_zotero_plan_document_action_state",
            )
          ) {
            if (failAssociation && JSON.parse(args[1]).savedNote)
              throw new Error("Association storage unavailable");
            state = JSON.parse(args[1]);
            return [];
          }
          if (sql.includes("llm_for_zotero_plan_document_action_state"))
            return state ? [{ payloadJson: JSON.stringify(state) }] : [];
          if (sql.includes("FROM llm_for_zotero_plan_documents"))
            return [{ payloadJson: JSON.stringify(document) }];
          return [];
        },
      },
    };
  });
  afterEach(function () {
    globals.Zotero = original;
  });
  it("prepares the exact stored document instead of asking the model to rewrite its body", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createEditCurrentNoteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      request: {
        conversationKey: 42,
        libraryID: 1,
        actionContract: {
          id: "workflow",
          obligations: [
            {
              id: "save",
              operation: "note_create",
              contentFrom: "summary",
              targetBoundary: { frozenTargetIds: [42] },
            },
          ],
        },
        actionProgress: {
          contractId: "workflow",
          materialOutputs: [
            {
              outputId: "summary",
              documentId: document.documentId,
              documentVersion: 1,
              contentHash: document.contentHash,
            },
          ],
        },
      },
    } as any;
    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);
    assert.equal(proposals[0].parameters?.documentId, document.documentId);
    assert.equal(proposals[0].parameters?.contentHash, document.contentHash);
    assert.include(
      proposals[0].parameters?.expectedText || "",
      "Exact durable summary.",
    );
  });
  it("does not duplicate a native note when recording its association fails", async function () {
    failAssociation = true;
    let error: unknown;
    try {
      await savePlanDocumentAsNote(document.documentId);
    } catch (failure) {
      error = failure;
    }
    assert.include(String(error), "Association storage unavailable");
    failAssociation = false;
    const saved = await savePlanDocumentAsNote(document.documentId);
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.equal(
      notes.size,
      1,
      "Retry must not leave an unassociated duplicate note",
    );
    assert.equal(saved.itemId, retried.itemId);
    assert.isFalse(retried.created);
    assert.equal(notes.get(saved.itemId).getNote(), document.visibleHtml);
  });
  it("binds a requested parent even when the summary contains no citation cluster", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId, {
      parentItemId: 42,
      libraryID: 1,
    });
    assert.equal(notes.get(saved.itemId).parentID, 42);
  });
  it("refuses to report an externally changed saved note as the original document", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId);
    notes.get(saved.itemId).stored = "<p>Different content</p>";
    let error: unknown;
    try {
      await savePlanDocumentAsNote(document.documentId);
    } catch (failure) {
      error = failure;
    }
    assert.instanceOf(error, Error);
    assert.equal(notes.size, 1);
  });
});
