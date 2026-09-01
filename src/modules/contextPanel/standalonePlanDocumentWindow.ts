import { config } from "../../../package.json";
import type { PlanDocument } from "../../agent/documents/types";
import { HTML_NS } from "../../utils/domHelpers";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  decoratePlanDocumentCitations,
  renderPlanDocumentFigures,
} from "./planDocumentPresentation";

const ROOT_ID = "llmforzotero-standalone-plan-document-root";
const WINDOW_FEATURES =
  "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen,dialog=no,dependent=no";

type OpenDialogWindow = Window & {
  openDialog?: (...args: unknown[]) => Window | null;
};

function createButton(
  doc: Document,
  label: string,
  title: string,
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function initialize(
  sourceDoc: Document,
  targetWin: Window,
  document: PlanDocument,
): boolean {
  if (targetWin.closed) return false;
  const doc = targetWin.document;
  const root = doc.getElementById(ROOT_ID) as HTMLElement | null;
  if (!root) return false;

  doc.title = document.title;
  doc.documentElement?.setAttribute("minwidth", "720");
  doc.documentElement?.setAttribute("minheight", "520");

  const sourceWin = sourceDoc.defaultView;
  if (sourceWin) {
    const computed = sourceWin.getComputedStyle(sourceDoc.documentElement);
    const variables = [
      "--fill-primary",
      "--fill-secondary",
      "--fill-tertiary",
      "--stroke-secondary",
      "--material-background",
      "--material-sidepane",
      "--color-accent",
    ]
      .map((name) => {
        const value = computed?.getPropertyValue(name).trim() || "";
        return value ? `${name}: ${value};` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (variables) {
      const style = doc.createElementNS(
        HTML_NS,
        "style",
      ) as HTMLStyleElement;
      style.textContent = `:root {\n${variables}\n}`;
      doc.documentElement?.prepend(style);
    }
  }

  const css = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
  css.rel = "stylesheet";
  css.type = "text/css";
  css.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(css);

  root.className = "llm-plan-document-window-root";
  const header = doc.createElementNS(HTML_NS, "header") as HTMLElement;
  header.className = "llm-plan-document-window-header";
  const title = doc.createElementNS(HTML_NS, "h1") as HTMLHeadingElement;
  title.textContent = document.title;
  const close = createButton(doc, "×", "Close document window");
  close.addEventListener("click", () => targetWin.close());
  header.append(title, close);

  const article = doc.createElementNS(HTML_NS, "article") as HTMLElement;
  article.className =
    "llm-plan-markdown llm-plan-document-window-content";
  renderRenderedMarkdownInto(article, document.visibleMarkdown, doc);
  decoratePlanDocumentCitations({ doc, root: article, document });

  const figures = renderPlanDocumentFigures(doc, document);
  root.replaceChildren(header, article);
  if (figures) root.appendChild(figures);
  doc.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") targetWin.close();
  });
  return true;
}

export function openStandalonePlanDocumentWindow(
  sourceDoc: Document,
  document: PlanDocument,
): boolean {
  const opener = sourceDoc.defaultView as OpenDialogWindow | null;
  if (!opener || typeof opener.openDialog !== "function") return false;
  const newWin = opener.openDialog(
    `chrome://${config.addonRef}/content/standalonePlanDocument.xhtml`,
    `llmforzotero-plan-document-${document.documentId}`,
    WINDOW_FEATURES,
  ) as Window | null;
  if (!newWin) return false;

  let attempts = 0;
  let initialized = false;
  const tryInitialize = () => {
    if (initialized || newWin.closed) return;
    if (initialize(sourceDoc, newWin, document)) {
      initialized = true;
      return;
    }
    attempts += 1;
    if (attempts < 40) newWin.setTimeout(tryInitialize, 25);
  };
  newWin.addEventListener("load", tryInitialize, { once: true });
  newWin.setTimeout(tryInitialize, 0);
  return true;
}
