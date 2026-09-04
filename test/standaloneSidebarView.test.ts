import { assert } from "chai";
import {
  createStandaloneSidebarView,
  setStandaloneSidebarLibraryName,
  setStandaloneSidebarState,
} from "../src/modules/contextPanel/standaloneSidebarView";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = "";
  id = "";
  textContent = "";
  title = "";
  type = "";
  tabIndex = -1;

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

describe("standalone sidebar view", function () {
  it("renders the current library as an icon-and-label header row", function () {
    const view = createStandaloneSidebarView(
      new FakeDocument() as unknown as Document,
      (value) => value,
    );

    assert.deepEqual(view.header.children, [
      view.libraryIdentity,
      view.toggleButton,
    ]);
    assert.deepEqual(view.libraryIdentity.children, [
      view.libraryIcon,
      view.libraryName,
    ]);
    assert.include(view.libraryIcon.className, "llm-standalone-library-icon");
    assert.equal(view.libraryIcon.getAttribute("aria-hidden"), "true");
  });

  it("keeps New chat, Search history, and Skills in the top navigation", function () {
    const view = createStandaloneSidebarView(
      new FakeDocument() as unknown as Document,
      (value) => value,
    );

    assert.deepEqual(
      view.primaryNavigation.children.flatMap((child) =>
        child.dataset.sidebarAction
          ? [child.dataset.sidebarAction]
          : child.children
              .map((nested) => nested.dataset.sidebarAction)
              .filter(Boolean),
      ),
      ["new-chat", "search-history", "skills"],
    );
    assert.deepEqual(
      [
        view.newChatLabel,
        view.searchButton.children[1],
        view.skillsLabel,
        view.preferencesLabel,
      ].map((label) => label.textContent),
      ["New chat", "Search history", "Skills", "Preferences"],
    );
    assert.deepEqual(view.panel.children, [
      view.header,
      view.primaryNavigation,
      view.historyRegion,
      view.preferencesRegion,
    ]);
    assert.equal(view.preferencesRegion.children[0], view.footerDivider);
    assert.equal(view.preferencesRegion.children[1], view.preferencesButton);
  });

  it("does not render a Chats label or an independently collapsible section", function () {
    const view = createStandaloneSidebarView(
      new FakeDocument() as unknown as Document,
      (value) => value,
    );

    assert.equal(view.searchButton.dataset.sidebarAction, "search-history");
    assert.equal(
      view.searchButton.getAttribute("aria-label"),
      "Search history",
    );
    assert.notInclude(JSON.stringify(view.panel), "chat-section-state");
  });

  it("uses one stateful sidebar for expanded labels and collapsed icons", function () {
    const view = createStandaloneSidebarView(
      new FakeDocument() as unknown as Document,
      (value) => value,
    );

    setStandaloneSidebarState(view, "collapsed");
    assert.equal(view.root.dataset.sidebarState, "collapsed");
    assert.equal(
      view.toggleButton.getAttribute("aria-label"),
      "Expand sidebar",
    );
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "false");

    setStandaloneSidebarState(view, "expanded");
    assert.equal(view.root.dataset.sidebarState, "expanded");
    assert.equal(
      view.toggleButton.getAttribute("aria-label"),
      "Collapse sidebar",
    );
    assert.equal(view.toggleButton.getAttribute("aria-expanded"), "true");
  });

  it("updates and exposes the complete current library name", function () {
    const view = createStandaloneSidebarView(
      new FakeDocument() as unknown as Document,
      (value) => value,
    );

    setStandaloneSidebarLibraryName(view, "A very long research library");

    assert.equal(view.libraryName.textContent, "A very long research library");
    assert.equal(view.libraryName.title, "A very long research library");
  });
});
