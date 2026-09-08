import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readPanelCss(): string {
  return readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");
}

function readStandaloneWindowSource(): string {
  return readFileSync(
    resolve(here, "../src/modules/contextPanel/standaloneWindow.ts"),
    "utf8",
  );
}

/**
 * Matches a rule by its selector without depending on how Prettier wrapped the
 * selector list across lines.
 */
function extractCssRule(css: string, selector: string): string {
  const flat = css.replace(/\s+/g, " ");
  const escapedSelector = selector
    .replace(/\s+/g, " ")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor on a rule, comment or block boundary so a selector is never matched
  // as the tail of a longer one.
  const match = flat.match(
    new RegExp(`(^|[};/]) ?${escapedSelector} \\{[^}]*\\}`),
  );
  return match?.[0] || "";
}

describe("standalone custom title bar CSS", function () {
  it("hands the native traffic lights their own reserved box", function () {
    const css = readPanelCss();
    const base = extractCssRule(css, ".llm-window-buttons");
    const active = extractCssRule(
      css,
      ":root[customtitlebar] .llm-window-buttons",
    );

    // Without the attribute the placeholder must not reserve any space, so
    // Windows and Linux keep the layout they have today.
    assert.include(base, "display: none");
    assert.include(active, "appearance: -moz-window-button-box");
    assert.include(active, "-moz-appearance: -moz-window-button-box");
    assert.include(active, "width: 52px");
    assert.include(active, "margin-inline-start: 12px");
  });

  it("makes the two top rows drag the window without swallowing their controls", function () {
    const css = readPanelCss();
    const dragRule = extractCssRule(
      css,
      ":root[customtitlebar] .llm-standalone-sidebar-header,\n:root[customtitlebar] .llm-standalone-tab-row",
    );
    const noDragRule = extractCssRule(
      css,
      ":root[customtitlebar] .llm-standalone-nav-toggle,\n:root[customtitlebar] .llm-standalone-tab-group,\n:root[customtitlebar] .llm-standalone-runtime-system-controls",
    );

    assert.include(dragRule, "-moz-window-dragging: drag");
    assert.include(noDragRule, "-moz-window-dragging: no-drag");
  });

  it("widens the collapsed rail to exactly the traffic light footprint", function () {
    const css = readPanelCss();
    const collapsedRail = extractCssRule(
      css,
      ':root[customtitlebar]\n  .llm-standalone-sidebar[data-sidebar-state="collapsed"]\n  .llm-standalone-sidebar-panel',
    );

    // 12px inset + 52px buttons + 12px trailing inset.
    assert.include(collapsedRail, "width: 76px");
  });

  it("keeps the collapsed header showing the window buttons after the toggle leaves", function () {
    const css = readPanelCss();
    const collapsedHeader = extractCssRule(
      css,
      ':root[customtitlebar]\n  .llm-standalone-sidebar[data-sidebar-state="collapsed"]\n  .llm-standalone-sidebar-header',
    );

    assert.include(collapsedHeader, "justify-content: flex-start");
  });

  it("keeps the segmented tabs centred once the tab row hosts the toggle", function () {
    const css = readPanelCss();
    const tabRow = extractCssRule(
      css,
      ":root[customtitlebar] .llm-standalone-tab-row",
    );

    // Both side columns grow by the same 38px so the centre column, and the
    // tab group inside it, stay centred on the content area.
    assert.include(tabRow, "grid-template-columns: 94px minmax(0, 1fr) 94px");
  });

  it("gives document windows a drag strip that content scrolls beneath", function () {
    const css = readPanelCss();
    const strip = extractCssRule(css, ".llm-document-titlebar");
    const content = extractCssRule(
      css,
      ":root[customtitlebar] .llm-plan-document-window-content",
    );

    assert.include(strip, "position: fixed");
    assert.include(strip, "height: 38px");
    assert.include(strip, "-moz-window-dragging: drag");
    assert.include(strip, "background: var(--material-background)");
    // 38px strip plus the 30px the document already reserved above its title.
    assert.include(content, "padding-top: 68px");
  });

  it("only offers the tab row as a toggle host when the title bar is custom", function () {
    const source = readStandaloneWindowSource();

    assert.include(source, 'hasAttribute("customtitlebar")');
    assert.include(source, "setStandaloneSidebarCollapsedToggleHost");
    assert.notInclude(source, "setStandaloneSidebarLibraryName");
    assert.notInclude(source, "syncStandaloneLibraryName");
  });
});
