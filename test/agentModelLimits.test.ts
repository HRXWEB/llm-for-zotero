import { assert } from "chai";
import { resolveAgentOutputTokenBudget } from "../src/agent/model/limits";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("agent model limits", function () {
  function deepSeekRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Continue the approved plan",
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/v1",
      providerProtocol: "openai_chat_compat",
      reasoning: { provider: "deepseek", level: "xhigh" },
      advanced: { maxTokens: 8192 },
      ...overrides,
    };
  }

  it("uses the declared output capability for an untouched thinking-model default", function () {
    assert.equal(
      resolveAgentOutputTokenBudget(deepSeekRequest(), "openai_chat_compat"),
      384_000,
    );
  });

  it("preserves an explicit user output limit", function () {
    assert.equal(
      resolveAgentOutputTokenBudget(
        deepSeekRequest({
          advanced: { maxTokens: 8192, maxTokensExplicit: true },
        }),
        "openai_chat_compat",
      ),
      8192,
    );
  });

  it("keeps the ordinary default when thinking is disabled", function () {
    assert.equal(
      resolveAgentOutputTokenBudget(
        deepSeekRequest({
          reasoning: { provider: "deepseek", level: "minimal" },
        }),
        "openai_chat_compat",
      ),
      8192,
    );
  });

  it("does not substitute the corruption ceiling for an unknown model", function () {
    assert.equal(
      resolveAgentOutputTokenBudget(
        deepSeekRequest({ model: "unknown-future-model" }),
        "openai_chat_compat",
      ),
      8192,
    );
  });
});
