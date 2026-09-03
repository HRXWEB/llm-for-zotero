import type { PlanDocument } from "../../agent/documents/types";
import { HTML_NS } from "../../utils/domHelpers";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  decoratePlanDocumentCitations,
  renderPlanDocumentFigures,
} from "./planDocumentPresentation";
import { openStandaloneDocumentWindow } from "./standaloneDocumentWindow";

const ROOT_ID = "llmforzotero-standalone-plan-document-root";

function renderPlanDocument(
  doc: Document,
  root: HTMLElement,
  document: PlanDocument,
): void {
  root.className = "llm-plan-document-window-root";
  const article = doc.createElementNS(HTML_NS, "article") as HTMLElement;
  article.className = "llm-plan-markdown llm-plan-document-window-content";
  renderRenderedMarkdownInto(article, document.visibleMarkdown, doc);
  const firstElement = article.firstElementChild;
  const firstHeadingMatchesTitle = Boolean(
    firstElement &&
    /^h[1-6]$/.test(firstElement.localName) &&
    (firstElement.textContent || "").trim() === document.title.trim(),
  );
  if (firstHeadingMatchesTitle) {
    firstElement?.classList.add("llm-plan-document-window-title");
  } else {
    const title = doc.createElementNS(HTML_NS, "h1") as HTMLHeadingElement;
    title.className = "llm-plan-document-window-title";
    title.textContent = document.title;
    article.prepend(title);
  }
  decoratePlanDocumentCitations({ doc, root: article, document });

  const figures = renderPlanDocumentFigures(doc, document);
  if (figures) article.appendChild(figures);
  root.replaceChildren(article);
}

export function openStandalonePlanDocumentWindow(
  sourceDoc: Document,
  document: PlanDocument,
): boolean {
  return openStandaloneDocumentWindow({
    sourceDoc,
    chromeDocument: "standalonePlanDocument.xhtml",
    windowName: `llmforzotero-plan-document-${document.documentId}`,
    rootId: ROOT_ID,
    title: document.title,
    render: (doc, root) => renderPlanDocument(doc, root, document),
  });
}
