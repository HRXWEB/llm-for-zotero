import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";

describe("bridge settings UI behavior", function () {
  it("persists bridge URL only on commit events", function () {
    const events: string[] = [];
    const commitBridgeUrl = () => {
      events.push("commit");
    };

    const inputListeners = new Map<string, () => void>();
    const input = {
      value: "http://127.0.0.1:19787",
      addEventListener(type: string, fn: () => void) {
        inputListeners.set(type, fn);
      },
    } as unknown as HTMLInputElement;

    input.addEventListener("change", commitBridgeUrl);
    input.addEventListener("blur", commitBridgeUrl);

    assert.isUndefined(inputListeners.get("input"));
    inputListeners.get("change")?.();
    inputListeners.get("blur")?.();
    assert.deepEqual(events, ["commit", "commit"]);
  });

  it("renders compact model input mode controls in advanced settings", function () {
    const preferenceScript = readFileSync(
      "src/modules/preferenceScript.ts",
      "utf8",
    );

    assert.include(preferenceScript, "getModelInputModeOptionsForRuntime");
    assert.include(preferenceScript, "INPUT_MODE_SELECT_SM_STYLE");
    assert.include(preferenceScript, 't("Input mode")');
    assert.include(preferenceScript, "inputModeOptions.length > 0");
    assert.include(preferenceScript, "normalizeModelInputModeForRuntime");
    assert.include(preferenceScript, "width: 108px");
  });

  it("translates model input mode preference strings in Chinese locale", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Input mode"), "输入模式");
      assert.equal(t("Text only"), "仅文本");
      assert.equal(t("Vision allowed"), "允许视觉");
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits  ·  Input mode: auto/text-only/vision",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值  ·  输入模式：自动/仅文本/视觉",
      );
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("translates the Original Agent permission instructions precisely", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Original Agent Mode"), "原生 Agent 模式");
      assert.equal(t("Library permissions"), "文献库权限");
      assert.equal(
        t(
          "Review every library change before it happens; batch jobs pause on each page.",
        ),
        "每次更改文献库前都需审核；批处理任务会在每一页暂停。",
      );
      assert.equal(
        t(
          "Apply reversible library changes automatically and ask before irreversible changes.",
        ),
        "自动应用可撤销的文献库更改，并在不可撤销的更改前询问。",
      );
      assert.equal(
        t(
          "Let the Original Agent apply changes on its own judgement, including irreversible changes and whole-library batch jobs.",
        ),
        "允许原生 Agent 自主判断并应用更改，包括不可撤销的更改和整个文献库的批处理任务。",
      );
      assert.equal(
        t(
          "This setting controls only Original Agent library actions. Original Agent, Claude Code, and Codex each use separate permission controls; changing one does not affect the other two. Reversible changes in all three Original Agent permission modes are recorded and can be reverted from Agent history.",
        ),
        "此设置仅控制原生 Agent 的文献库操作。原生 Agent、Claude Code 和 Codex 各自使用独立的权限控制；更改任一模式都不会影响另外两种模式。原生 Agent 三种权限模式下的可撤销更改都会被记录，并可从 Agent 历史记录中撤销。",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("groups Original Agent controls and Tavily in one card", function () {
    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    const originalAgentCardStart = preferences.indexOf(
      'id="__addonRef__-original-agent-card"',
    );
    const originalAgentCardEnd = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    const originalAgentCard = preferences.slice(
      originalAgentCardStart,
      originalAgentCardEnd,
    );

    assert.isAtLeast(originalAgentCardStart, 0);
    assert.isAbove(originalAgentCardEnd, originalAgentCardStart);
    assert.include(originalAgentCard, 'id="__addonRef__-enable-agent-mode"');
    assert.include(
      originalAgentCard,
      'id="__addonRef__-agent-library-write-mode"',
    );
    assert.include(originalAgentCard, 'id="__addonRef__-tavily-card"');
  });
});
