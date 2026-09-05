import { assert } from "chai";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

describe("ranked literature discovery workflow", function () {
  const originalFetch = globalThis.fetch;
  const gateway = {
    resolveMetadataItem: () => null,
    getEditableArticleMetadata: () => null,
    getCollectionSummary: (id: number) =>
      id === 79
        ? {
            collectionId: 79,
            libraryID: 1,
            name: "Research",
            path: "Lab / Research",
          }
        : null,
  };
  const makeContext = (mode = "auto"): AgentToolContext => ({
    request: resolvedAgentRequest({
      conversationKey: 9901,
      libraryID: 1,
      mode: "agent",
      userText: "Find five papers relevant to the current paper.",
      metadata: { permissionMode: mode },
    }),
    runId: "discovery-test-run",
    resourceSignature: "paper-A",
    item: null,
    currentAnswerText: "",
    modelName: "test",
  });
  const resultOf = (name: string, content: unknown): AgentToolResult => ({
    name,
    callId: "test-call",
    ok: true,
    actionReceipts: [],
    content,
  });
  beforeEach(function () {
    clearAgentToolResultHandleStore();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: `Candidate ${i + 1}`,
          doi: `https://doi.org/10.1000/candidate-${i + 1}`,
          publication_year: 2024,
          authorships: [{ author: { display_name: "Fixture Author" } }],
        })),
      }),
    })) as typeof fetch;
  });
  afterEach(function () {
    globalThis.fetch = originalFetch;
    clearAgentToolResultHandleStore();
  });

  async function search(context = makeContext()) {
    const tool = createSearchLiteratureOnlineTool(gateway as never);
    const input = tool.validate({
      mode: "search",
      workflow: "review",
      query: "population coding",
      limit: 12,
    });
    if (!input.ok) throw new Error(input.error);
    const content = (await tool.execute(input.value, context)) as any;
    assert.lengthOf(content.results, 12);
    assert.isString(content.candidateSetId);
    assert.isTrue(content.reviewRequired);
    assert.isNull(
      await tool.createResultReviewAction?.(
        input.value,
        resultOf("literature_search", content),
        context,
      ),
    );
    return content;
  }

  for (const mode of ["safe", "auto", "yolo"]) {
    it(`preserves requested user selection before import in ${mode}`, async function () {
      const context = makeContext(mode);
      context.request.userText =
        "Find five papers relevant to the current paper and import only the ones I select.";
      const candidates = await search(context);
      const tool = createLiteratureReviewTool(gateway as never);
      const input = tool.validate({
        selections: [1, 2, 3, 4, 5].map((candidateIndex) => ({
          candidateSetId: candidates.candidateSetId,
          candidateIndex,
          reason: "Relevant title and abstract",
        })),
      });
      if (!input.ok) throw new Error(input.error);
      const content = await tool.execute(input.value, context);
      const card = await tool.createResultReviewAction!(
        input.value,
        resultOf("literature_review", content),
        context,
      );
      assert.exists(card);
      assert.deepEqual(
        card!.actions!.map((action) => action.id),
        ["import", "cancel"],
      );
    });

    it(`lets the agent rank twelve candidates into five paper-only choices in ${mode}`, async function () {
      const context = makeContext(mode);
      const candidates = await search(context);
      const tool = createLiteratureReviewTool(gateway as never);
      const ranked = [8, 2, 10, 4, 1];
      const input = tool.validate({
        selections: ranked.map((candidateIndex) => ({
          candidateSetId: candidates.candidateSetId,
          candidateIndex,
          reason: `Evidence-based relevance for candidate ${candidateIndex}`,
        })),
        targetCollectionId: 79,
      });
      if (!input.ok) throw new Error(input.error);
      const content = await tool.execute(input.value, context);
      const result = resultOf("literature_review", content);
      const card = await tool.createResultReviewAction!(
        input.value,
        result,
        context,
      );
      assert.exists(card);
      assert.deepEqual(
        card!.fields.map((field) => field.type),
        ["paper_result_list"],
      );
      assert.deepEqual(
        card!.actions!.map((action) => action.id),
        ["import", "cancel"],
      );
      assert.include(card!.description, "Lab / Research");
      const list = card!.fields[0];
      if (list.type !== "paper_result_list") throw new Error("Wrong field");
      assert.deepEqual(
        list.rows.map((row) => row.title),
        ranked.map((i) => `Candidate ${i}`),
      );
      assert.include(list.rows[0].body, "relevance");
      const cancelled = await tool.resolveResultReview!(
        input.value,
        result,
        { approved: false },
        context,
      );
      assert.equal(cancelled.kind, "stop");
      const approved = await tool.resolveResultReview!(
        input.value,
        result,
        {
          approved: true,
          actionId: "import",
          data: { selectedPaperIds: [list.rows[0].id, list.rows[2].id] },
        },
        context,
      );
      assert.equal(approved.kind, "invoke_tool");
      if (approved.kind !== "invoke_tool") return;
      assert.equal(approved.call.name, "library_import");
      assert.deepInclude(approved.call.arguments, {
        identifiers: ["10.1000/candidate-8", "10.1000/candidate-10"],
        libraryID: 1,
        targetCollectionId: 79,
      });
    });
  }

  it("rejects wrong counts, duplicate candidates, unknown references, stale context and foreign destinations", async function () {
    const context = makeContext();
    const candidates = await search(context);
    const tool = createLiteratureReviewTool(gateway as never);
    const selections = [1, 2, 3, 4, 5].map((candidateIndex) => ({
      candidateSetId: candidates.candidateSetId,
      candidateIndex,
      reason: "Relevant evidence",
    }));
    for (const [args, changedContext] of [
      [{ selections: selections.slice(0, 4) }, context],
      [{ selections: [...selections.slice(0, 4), selections[0]] }, context],
      [
        {
          selections: selections.map((s) => ({
            ...s,
            candidateSetId: "trh_missing",
          })),
        },
        context,
      ],
      [{ selections }, { ...context, runId: "another-run" }],
      [{ selections, targetCollectionId: 12345 }, context],
    ] as const) {
      const input = tool.validate(args);
      if (!input.ok) continue;
      let rejected = false;
      try {
        await tool.execute(input.value, changedContext);
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected, JSON.stringify(args));
    }
  });

  it("does not accept prose as completed discovery while a shortlist review is still required", async function () {
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(
      context.request,
      { evaluateFinal: async () => ({ kind: "accept" }) },
      [],
    );
    const first = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: true,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct")
      assert.include(first.correction, "literature_review");
    const second = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: true,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    assert.equal(second.kind, "fail");
  });
});
