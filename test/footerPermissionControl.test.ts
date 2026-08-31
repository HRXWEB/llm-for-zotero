import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  FOOTER_PERMISSION_MODE_OPTIONS,
  shouldShowFooterPermissionControl,
} from "../src/modules/contextPanel/footerPermissionControl";

describe("footer permission control", function () {
  it("exposes implemented modes and keeps plan as an honest placeholder", function () {
    assert.deepEqual(FOOTER_PERMISSION_MODE_OPTIONS, [
      { mode: "safe", available: true },
      { mode: "auto", available: true },
      { mode: "yolo", available: true },
      { mode: "plan", available: false },
    ]);
  });

  it("shows only for the original Agent Mode runtime", function () {
    assert.isTrue(
      shouldShowFooterPermissionControl({
        conversationSystem: "upstream",
        runtimeMode: "agent",
      }),
    );
    assert.isFalse(
      shouldShowFooterPermissionControl({
        conversationSystem: "upstream",
        runtimeMode: "chat",
      }),
    );
    assert.isFalse(
      shouldShowFooterPermissionControl({
        conversationSystem: "claude_code",
        runtimeMode: "agent",
      }),
    );
    assert.isFalse(
      shouldShowFooterPermissionControl({
        conversationSystem: "codex",
        runtimeMode: "chat",
      }),
    );
  });

  it("keeps the permission selector and context gauge together on the footer right", function () {
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.include(
      buildUi,
      "footerControls.append(permissionControl, contextUsageControl)",
    );
    assert.include(buildUi, "statusBar.append(statusLine, footerControls)");
    assert.notInclude(buildUi, "llm-claude-context-gauge");
  });

  it("uses semantic backgrounds for available modes and keeps plan neutral", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.include(
      css,
      '.llm-permission-option[data-permission-mode="safe"] {\n  --llm-permission-mode-color: #22c55e;',
    );
    assert.include(
      css,
      '.llm-permission-option[data-permission-mode="auto"] {\n  --llm-permission-mode-color: #3b82f6;',
    );
    assert.include(
      css,
      '.llm-permission-option[data-permission-mode="yolo"] {\n  --llm-permission-mode-color: #eab308;',
    );
    assert.notInclude(
      css,
      '.llm-permission-option[data-permission-mode="plan"]',
    );
    assert.match(
      css,
      /\.llm-permission-option:not\(:disabled\)\s*\{[\s\S]*?var\(--llm-permission-mode-color\) 14%/,
    );
  });

  it("pins permission and context controls to the first status line", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.match(
      css,
      /\.llm-status-bar\s*\{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?align-items: baseline;/,
    );
    assert.match(
      css,
      /\.llm-status\s*\{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 1;[\s\S]*?white-space: normal;/,
    );
    assert.match(
      css,
      /\.llm-footer-controls\s*\{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;[\s\S]*?align-self: baseline;/,
    );
  });

  it("keeps the footer visible on a blank conversation and renders a hollow ring", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.notInclude(
      css,
      '[data-start-page-active="true"] .llm-status-bar {\n  display: none;',
    );
    assert.match(
      css,
      /\.llm-context-gauge\s*\{[\s\S]*?width: var\(--llm-fs-11\);[\s\S]*?height: var\(--llm-fs-11\);/,
    );
    assert.match(
      css,
      /\.llm-context-gauge::after\s*\{[\s\S]*?inset: calc\(2px \* var\(--llm-font-scale\)\);[\s\S]*?background: var\(--material-sidepane\);/,
    );
    assert.match(
      css,
      /\.llm-status,\s*\.llm-permission-toggle\s*\{[\s\S]*?font-size: var\(--llm-fs-11\);[\s\S]*?line-height: 1\.2;/,
    );
  });
});
