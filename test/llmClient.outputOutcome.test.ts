import { assert } from "chai";
import {
  normalizeProviderCompletion,
  parseResponsesStream,
  parseStreamResponse,
} from "../src/utils/llmClient";

function makeSseStream(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("LLM terminal outcome normalization", function () {
  it("maps provider terminal reasons without conflating their causes", function () {
    assert.deepEqual(normalizeProviderCompletion("length"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
    assert.deepEqual(normalizeProviderCompletion("MAX_TOKENS"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "MAX_TOKENS",
    });
    assert.deepEqual(
      normalizeProviderCompletion("model_context_window_exceeded"),
      {
        status: "incomplete",
        reason: "context_limit",
        providerReason: "model_context_window_exceeded",
      },
    );
    assert.deepEqual(normalizeProviderCompletion("pause_turn"), {
      status: "incomplete",
      reason: "provider_pause",
      providerReason: "pause_turn",
    });
    assert.deepEqual(normalizeProviderCompletion("content_filter"), {
      status: "blocked",
      reason: "safety",
      providerReason: "content_filter",
    });
    assert.deepEqual(normalizeProviderCompletion("refusal"), {
      status: "blocked",
      reason: "refusal",
      providerReason: "refusal",
    });
    assert.deepEqual(normalizeProviderCompletion("MALFORMED_FUNCTION_CALL"), {
      status: "blocked",
      reason: "malformed_tool_call",
      providerReason: "MALFORMED_FUNCTION_CALL",
    });
    assert.deepEqual(
      normalizeProviderCompletion(undefined, { responseStatus: "failed" }),
      {
        status: "blocked",
        reason: "other",
        providerReason: "failed",
      },
    );
  });

  it("preserves partial Chat Completions text and marks finish_reason length incomplete", async function () {
    const deltas: string[] = [];
    const outcome = await parseStreamResponse(
      makeSseStream([
        { choices: [{ delta: { content: "Partial answer" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
      (delta) => deltas.push(delta),
    );

    assert.equal(outcome.text, "Partial answer");
    assert.equal(deltas.join(""), "Partial answer");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
  });

  it("preserves Responses continuation state for a reasoning-only cutoff", async function () {
    const outcome = await parseResponsesStream(
      makeSseStream([
        {
          type: "response.reasoning_summary.delta",
          delta: "Private progress summary",
          response: { id: "resp_456" },
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp_456",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      () => undefined,
    );

    assert.equal(outcome.text, "");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "max_output_tokens",
    });
    assert.deepEqual(outcome.continuationState, { responseId: "resp_456" });
  });
});
