import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolveStandalonePaperTabLabel } from "../src/modules/contextPanel/standaloneTabLabel";
import { t } from "../src/utils/i18n";

describe("standaloneTabLabel", function () {
  it("translates the rendered paper tab on creation and mode refresh", function () {
    const source = readFileSync(
      new URL(
        "../src/modules/contextPanel/standaloneWindow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const assignments = Array.from(
      source.matchAll(/paperTab\.textContent = ([\s\S]*?);/g),
      (match) => match[1],
    );
    assert.lengthOf(assignments, 2, "creation and mode refresh assignments");
    const originalZotero = (globalThis as any).Zotero;
    try {
      for (const [locale, expected] of [
        ["zh-CN", "论文对话"],
        ["en-US", "Paper chat"],
      ]) {
        (globalThis as any).Zotero = { locale };
        for (const assignment of assignments) {
          const render = new Function(
            "resolveStandalonePaperTabLabel",
            "t",
            "isInWebChatMode",
            `return ${assignment};`,
          );
          assert.equal(
            render(resolveStandalonePaperTabLabel, t, false),
            expected,
          );
        }
      }
    } finally {
      (globalThis as any).Zotero = originalZotero;
    }
  });

  it("labels the paper tab as Paper chat by default", function () {
    assert.equal(resolveStandalonePaperTabLabel(), "Paper chat");
  });

  it("overrides the paper slot label with Web chat while webchat is active", function () {
    assert.equal(
      resolveStandalonePaperTabLabel({ isWebChat: true }),
      "Web chat",
    );
  });
});
