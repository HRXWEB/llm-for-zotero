import { assert } from "chai";
import {
  AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  resolveOutputRequestPolicy,
  resolveOutputReserve,
} from "../src/utils/outputTokenPolicy";

describe("output token policy", function () {
  it("omits optional provider caps in Auto mode", function () {
    for (const protocol of [
      "responses_api",
      "openai_chat_compat",
      "gemini_native",
    ] as const) {
      assert.deepEqual(
        resolveOutputRequestPolicy({
          setting: { mode: "auto" },
          model: "unknown-model",
          protocol,
          authMode: "api_key",
        }),
        { mode: "omit", source: "auto_provider" },
      );
    }
  });

  it("keeps native harness output limits runtime-managed", function () {
    for (const authMode of ["codex_auth", "codex_app_server"] as const) {
      assert.deepEqual(
        resolveOutputRequestPolicy({
          setting: { mode: "custom", tokens: 123 },
          model: "gpt-5.6-sol",
          protocol: "codex_responses",
          authMode,
        }),
        { mode: "runtime_managed", source: "runtime" },
      );
    }
  });

  it("uses an authoritative capability for required Anthropic max_tokens", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "auto" },
        model: "claude-sonnet-4-6",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      { mode: "numeric", tokens: 64_000, source: "auto_capability" },
    );
  });

  it("uses a compatibility seed only when Anthropic capability is unknown", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "auto" },
        model: "unknown-anthropic-compatible-model",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      {
        mode: "numeric",
        tokens: AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
        source: "auto_compatibility",
      },
    );
  });

  it("honors and defensively clamps custom limits", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "custom", tokens: 200_000 },
        model: "claude-sonnet-4-6",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      { mode: "numeric", tokens: 64_000, source: "custom" },
    );
  });

  it("keeps context reservation separate from the transmitted Auto policy", function () {
    assert.equal(
      resolveOutputReserve({ mode: "auto" }, "deepseek-v4-pro"),
      DEFAULT_OUTPUT_RESERVE_TOKENS,
    );
    assert.equal(
      resolveOutputReserve(
        { mode: "custom", tokens: 2_048 },
        "deepseek-v4-pro",
      ),
      2_048,
    );
  });
});
