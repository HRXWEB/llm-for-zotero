import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: streaming responsiveness", function () {
  this.timeout(120000);
  for (const historyTurns of [2, 60]) {
    it(`preserves progress, focus and manual scrolling with ${historyTurns} earlier turns`, async function () {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const fixture = await api.createPaperWithPdfFixture({
        title: "Streaming responsiveness",
        pages: ["Fixture evidence."],
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const result = await api.exerciseStreamingReplay({
          panelId: panel.panelId,
          historyTurns,
          chunks: 30,
        });
        Zotero.debug(`STREAMING_REPLAY ${JSON.stringify(result)}`, 1);
        await Zotero.File.putContentsAsync(
          `/tmp/streaming-replay-${historyTurns}.json`,
          JSON.stringify(result),
        );
        assert.equal(
          result.wrapperReplacements,
          0,
          "text chunks preserve the assistant wrapper",
        );
        assert.equal(
          result.progressReplacements,
          0,
          "text chunks preserve the progress view",
        );
        assert.equal(
          result.progressMutations,
          0,
          "text chunks do no progress work",
        );
        assert.isTrue(result.focusPreserved);
        assert.closeTo(result.manualScrollDelta, 0, 2);
        assert.isTrue(result.exactReasoning);
        assert.isTrue(result.statusVisible);
        assert.equal(result.ledgerReadsDuringText, 0);
        assert.isTrue(result.progressUpdatePreserved);
        assert.isTrue(result.finalAnswerVisible);
        assert.isTrue(result.composerPreserved);
        assert.isTrue(
          result.resumeVisibilityCorrect,
          "resume is visible only when interrupted",
        );
        assert.isTrue(
          result.singleExecutionProgress,
          "resumed turns share one panel-owned progress view",
        );
      } finally {
        await api.reset();
        await api.cleanupFixture(fixture);
      }
    });
  }
});
