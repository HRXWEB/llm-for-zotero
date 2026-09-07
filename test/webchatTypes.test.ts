import { assert } from "chai";
import {
  getWebChatConversationId,
  getWebChatTarget,
  getWebChatTargetByModelName,
  getWebChatTargetByUrl,
  getWebChatTargetDisplayName,
  isWebChatUrlForTarget,
} from "../src/webchat/types";

describe("webchat target types", function () {
  it("keeps canonical host model names separate from compact display names", function () {
    assert.equal(
      getWebChatTargetByModelName("chatgpt.com")?.modelName,
      "chatgpt.com",
    );
    assert.equal(
      getWebChatTargetByModelName("chat.deepseek.com")?.modelName,
      "chat.deepseek.com",
    );

    assert.equal(getWebChatTargetDisplayName("chatgpt.com"), "chatgpt");
    assert.equal(getWebChatTargetDisplayName("chat.deepseek.com"), "deepseek");
  });

  it("registers Google Gemini under its canonical host", function () {
    assert.deepInclude(getWebChatTarget("gemini"), {
      id: "gemini",
      label: "Google Gemini",
      modelName: "gemini.google.com",
      displayName: "gemini",
    });
    assert.equal(
      getWebChatTargetByModelName("gemini.google.com")?.id,
      "gemini",
    );
  });

  it("routes only exact HTTPS provider hosts", function () {
    assert.equal(
      getWebChatTargetByUrl("https://gemini.google.com.com/app/thread-1")?.id,
      undefined,
    );
    assert.equal(
      getWebChatTargetByUrl("https://gemini.google.com.evil.test/app/thread-1")
        ?.id,
      undefined,
    );
    assert.equal(
      getWebChatTargetByUrl("https://evil.test/?next=gemini.google.com")?.id,
      undefined,
    );
    assert.equal(
      getWebChatTargetByUrl("http://gemini.google.com/app/thread-1")?.id,
      undefined,
    );
    assert.isFalse(
      isWebChatUrlForTarget(
        "https://www.gemini.google.com/app/thread-1",
        "gemini",
      ),
    );
    assert.equal(
      getWebChatTargetByUrl("https://gemini.google.com/app/thread-1")?.id,
      "gemini",
    );
  });

  it("extracts conversation ids only from observed provider paths", function () {
    assert.equal(
      getWebChatConversationId(
        "https://gemini.google.com/app/a3ba6a650dc4b726?hl=en",
        "gemini",
      ),
      "a3ba6a650dc4b726",
    );
    assert.isNull(
      getWebChatConversationId(
        "https://gemini.google.com/chat/a3ba6a650dc4b726",
        "gemini",
      ),
    );
    assert.isNull(
      getWebChatConversationId(
        "https://gemini.google.com/app/a3ba6a650dc4b726/extra",
        "gemini",
      ),
    );
    assert.isNull(
      getWebChatConversationId(
        "https://gemini.google.com.evil.test/app/a3ba6a650dc4b726",
        "gemini",
      ),
    );
  });
});
