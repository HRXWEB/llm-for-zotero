import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  FOOTER_PERMISSION_MODE_OPTIONS,
  shouldShowFooterPermissionControl,
} from "../src/modules/contextPanel/footerPermissionControl";
import { positionFloatingMenu } from "../src/modules/contextPanel/setupHandlers/controllers/menuController";

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

  it("uses mode-colored backgrounds only while an available option is hovered", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.notInclude(css, ".llm-permission-option::before");
    assert.notInclude(css, ".llm-permission-option-selected::before");
    assert.match(
      css,
      /\.llm-permission-option:hover:not\(:disabled\)\s*\{\s*border-color: var\(--stroke-secondary/,
    );
    assert.match(
      css,
      /\.llm-permission-option\[data-permission-mode="safe"\]:hover:not\(:disabled\)\s*\{[\s\S]*?#22c55e 14%/,
    );
    assert.match(
      css,
      /\.llm-permission-option\[data-permission-mode="auto"\]:hover:not\(:disabled\)\s*\{[\s\S]*?background: var\(--color-accent10/,
    );
    assert.match(
      css,
      /\.llm-permission-option\[data-permission-mode="yolo"\]:hover:not\(:disabled\)\s*\{[\s\S]*?#eab308 14%/,
    );
    assert.notInclude(
      css,
      '.llm-permission-option[data-permission-mode="plan"]',
    );
    const selectedRules = css.match(
      /\.llm-permission-option-selected:not\(:disabled\)\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    assert.notInclude(selectedRules, "background:");
    assert.match(
      css,
      /\.llm-permission-option-selected:not\(:disabled\)\s*\{[\s\S]*?border-color: var\(--color-accent/,
    );
    assert.match(
      css,
      /\.llm-permission-option:focus-visible:not\(:disabled\)\s*\{[\s\S]*?outline: 1px solid var\(--color-accent/,
    );
    assert.match(
      css,
      /\.llm-permission-option:disabled\s*\{[\s\S]*?opacity: 0\.48;[\s\S]*?background: transparent;[\s\S]*?border-color: transparent;/,
    );
    assert.notInclude(css, ".llm-permission-option:disabled::after");
    assert.notInclude(css, 'content: "later"');
    assert.notInclude(
      buildUi,
      'title: option.available ? option.mode : t("Coming later")',
    );
  });

  it("matches the paper picker card geometry with symmetric side spacing", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const controller = readFileSync(
      "src/modules/contextPanel/footerPermissionControl.ts",
      "utf8",
    );

    assert.match(
      css,
      /\.llm-permission-menu\s*\{[\s\S]*?gap: 3px;[\s\S]*?width: max-content;[\s\S]*?min-width: 0;[\s\S]*?padding-block: 6px;[\s\S]*?padding-inline: 6px;[\s\S]*?border-radius: 12px;[\s\S]*?box-shadow: 0 8px 18px rgba\(0, 0, 0, 0\.24\);/,
    );
    assert.match(
      css,
      /\.llm-permission-option\s*\{[\s\S]*?all: unset;[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?padding-block: 7px;[\s\S]*?padding-inline: 9px;[\s\S]*?border: 1px solid transparent;[\s\S]*?border-radius: 8px;/,
    );
    assert.include(
      controller,
      'if (menu.scrollHeight <= menu.clientHeight) {\n      menu.style.overflowY = "hidden";',
    );
  });

  it("centers the menu directly above the permission mode", function () {
    const style: Record<string, string> = {};
    const owner = {
      ownerDocument: {
        defaultView: { innerWidth: 400, innerHeight: 600 },
      },
      getBoundingClientRect: () => ({
        left: 0,
        right: 400,
        top: 0,
        bottom: 600,
        width: 400,
        height: 600,
      }),
    } as unknown as Element;
    const menu = {
      style,
      getBoundingClientRect: () => ({ width: 100, height: 120 }),
    } as unknown as HTMLDivElement;
    const anchor = {
      getBoundingClientRect: () => ({
        left: 260,
        right: 300,
        top: 500,
        bottom: 520,
        width: 40,
        height: 20,
      }),
    } as unknown as HTMLButtonElement;

    positionFloatingMenu(owner, menu, anchor, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });

    assert.equal(style.left, "230px");
    assert.equal(style.top, "374px");
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
