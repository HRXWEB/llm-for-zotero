import { assert } from "chai";

import { openStandaloneDocumentWindow } from "../src/modules/contextPanel/standaloneDocumentWindow";

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly attributes: Record<string, string> = {};
  public className = "";
  public textContent = "";
  public rel = "";
  public type = "";
  public href = "";

  prepend(child: FakeElement): void {
    this.children.unshift(child);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

class FakeDocument {
  public readonly documentElement = new FakeElement();
  public title = "";
  public defaultView: unknown = null;
  private readonly keydownListeners: Array<(event: { key: string }) => void> =
    [];

  constructor(public readonly root: FakeElement) {}

  getElementById(id: string): FakeElement | null {
    return id === "document-root" ? this.root : null;
  }

  createElementNS(_namespace: string, _name: string): FakeElement {
    return new FakeElement();
  }

  addEventListener(
    type: string,
    listener: (event: { key: string }) => void,
  ): void {
    if (type === "keydown") this.keydownListeners.push(listener);
  }

  dispatchKey(key: string): void {
    for (const listener of this.keydownListeners) listener({ key });
  }
}

function createWindow(doc: FakeDocument) {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    closed: false,
    focusCount: 0,
    document: doc,
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
    focus() {
      this.focusCount += 1;
    },
    close() {
      this.closed = true;
      for (const listener of listeners.get("unload") || []) listener();
    },
  };
  doc.defaultView = win;
  return win;
}

describe("standalone document window", function () {
  it("installs source styling, renders once, focuses an existing key, and closes on Escape", function () {
    const firstDoc = new FakeDocument(new FakeElement());
    const secondDoc = new FakeDocument(new FakeElement());
    const windows = [createWindow(firstDoc), createWindow(secondDoc)];
    const openCalls: unknown[][] = [];
    const sourceDoc = {
      documentElement: new FakeElement(),
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) =>
            name === "--fill-primary" ? "rgb(1, 2, 3)" : "",
        }),
        openDialog: (...args: unknown[]) => {
          openCalls.push(args);
          return windows[openCalls.length - 1];
        },
      },
    };
    let renderCount = 0;
    const options = {
      sourceDoc: sourceDoc as unknown as Document,
      chromeDocument: "standaloneResponseDocument.xhtml",
      windowName: "response-window-1",
      rootId: "document-root",
      title: "Response from Codex",
      render: (_doc: Document, root: HTMLElement) => {
        renderCount += 1;
        root.className = "rendered";
      },
    };

    assert.isTrue(openStandaloneDocumentWindow(options));
    assert.equal(renderCount, 1);
    assert.lengthOf(openCalls, 1);
    assert.include(String(openCalls[0][0]), "standaloneResponseDocument.xhtml");
    assert.equal(firstDoc.title, "Response from Codex");
    assert.equal(firstDoc.documentElement.attributes.minwidth, "720");
    assert.equal(firstDoc.documentElement.attributes.minheight, "520");
    assert.equal(firstDoc.root.className, "rendered");
    assert.equal(
      firstDoc.documentElement.children[0].textContent.includes(
        "--fill-primary",
      ),
      true,
    );
    assert.equal(firstDoc.documentElement.children[1].rel, "stylesheet");

    assert.isTrue(openStandaloneDocumentWindow(options));
    assert.lengthOf(openCalls, 1);
    assert.equal(windows[0].focusCount, 1);
    assert.equal(renderCount, 1);

    assert.isTrue(
      openStandaloneDocumentWindow({
        ...options,
        windowName: "response-window-2",
      }),
    );
    assert.lengthOf(openCalls, 2);
    assert.equal(renderCount, 2);

    firstDoc.dispatchKey("Escape");
    assert.isTrue(windows[0].closed);
    assert.isFalse(windows[1].closed);
    windows[1].close();
  });
});
