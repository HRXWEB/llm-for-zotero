import type {
  FormattedCitationCluster,
  PlanCitationSource,
  PlanDocument,
} from "../../agent/documents/types";
import { toFileUrl } from "../../utils/pathFileUrl";

export function getPlanDocumentItemTitle(
  libraryID: number,
  itemKey: string,
): string {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  if (!item) return itemKey;
  return item.getDisplayTitle?.() || item.getField?.("title") || itemKey;
}

export function planDocumentCitationSourceHref(
  source: PlanCitationSource,
): string {
  const isUserLibrary =
    source.libraryID === Number(Zotero.Libraries.userLibraryID);
  const groupID = isUserLibrary
    ? undefined
    : (
        Zotero.Libraries.get(source.libraryID) as
          | { groupID?: number }
          | undefined
      )?.groupID;
  const libraryPath = groupID ? `groups/${groupID}` : "library";
  return source.locator
    ? `zotero://open-pdf/${libraryPath}/items/${source.locator.attachmentItemKey}?page=${source.locator.pageIndex + 1}`
    : `zotero://select/${libraryPath}/items/${source.itemKey}`;
}

function selectZoteroLibraryTab(): void {
  const localTabs = (Zotero as unknown as { Tabs?: unknown }).Tabs;
  let mainWindowTabs: unknown;
  try {
    mainWindowTabs = (
      Zotero.getMainWindow?.() as
        | { Zotero?: { Tabs?: unknown } }
        | null
        | undefined
    )?.Zotero?.Tabs;
  } catch {
    mainWindowTabs = undefined;
  }
  for (const candidate of [localTabs, mainWindowTabs]) {
    const tabs = candidate as
      | { select?: (tabID: string | number) => unknown }
      | null
      | undefined;
    if (typeof tabs?.select !== "function") continue;
    try {
      tabs.select("zotero-pane");
      return;
    } catch {
      // Fall through to the next live Zotero window candidate.
    }
  }
}

export async function navigatePlanDocumentCitationSource(
  source: PlanCitationSource,
): Promise<boolean> {
  if (source.locator) {
    const attachment = Zotero.Items.getByLibraryAndKey(
      source.libraryID,
      source.locator.attachmentItemKey,
    );
    const reader = Zotero.Reader as
      | {
          open?: (
            itemID: number,
            location?: _ZoteroTypes.Reader.Location,
          ) => Promise<unknown>;
        }
      | undefined;
    if (attachment && typeof reader?.open === "function") {
      await reader.open(Number(attachment.id), {
        pageIndex: source.locator.pageIndex,
      });
      return true;
    }
  }

  const item = Zotero.Items.getByLibraryAndKey(source.libraryID, source.itemKey);
  if (!item) return false;
  // selectItems() updates the library selection but does not necessarily make
  // it visible when the user clicked from a reader-backed document card.
  selectZoteroLibraryTab();
  const pane = Zotero.getActiveZoteroPane?.() as
    | _ZoteroTypes.ZoteroPane
    | undefined;
  if (!pane) return false;
  if (typeof pane.selectItems === "function") {
    const selected = await (
      pane.selectItems as (
        itemIDs: number[],
        options?: { selectInLibrary?: boolean },
      ) => unknown
    )([Number(item.id)], { selectInLibrary: true });
    if (selected !== false) return true;
  }
  if (typeof pane.selectItem === "function") {
    return pane.selectItem(Number(item.id), true) !== false;
  }
  return false;
}

function attachSourceNavigation(
  link: HTMLAnchorElement,
  source: PlanCitationSource,
  afterNavigate?: () => void,
): void {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigatePlanDocumentCitationSource(source).finally(() =>
      afterNavigate?.(),
    );
  });
}

function showCitationSourceChooser(params: {
  doc: Document;
  cluster: FormattedCitationCluster;
}): void {
  const backdrop = params.doc.createElement("div");
  backdrop.className = "llm-plan-document-dialog-backdrop";
  const dialog = params.doc.createElement("section");
  dialog.className = "llm-plan-document-source-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const header = params.doc.createElement("div");
  header.className = "llm-plan-document-dialog-header";
  const title = params.doc.createElement("strong");
  title.textContent = "Citation sources";
  const close = params.doc.createElement("button");
  close.type = "button";
  close.className = "llm-plan-document-dialog-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close source chooser");
  const dismiss = () => backdrop.remove();
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) dismiss();
  });
  header.append(title, close);
  const list = params.doc.createElement("div");
  list.className = "llm-plan-document-source-list";
  for (const source of params.cluster.sources) {
    const link = params.doc.createElement("a");
    link.className = "llm-plan-document-source-link";
    link.href = planDocumentCitationSourceHref(source);
    link.textContent = getPlanDocumentItemTitle(
      source.libraryID,
      source.itemKey,
    );
    attachSourceNavigation(link, source, dismiss);
    const detail = params.doc.createElement("span");
    detail.textContent = source.locator
      ? `PDF page ${source.locator.pageIndex + 1}`
      : "Zotero item";
    link.appendChild(detail);
    list.appendChild(link);
  }
  dialog.append(header, list);
  backdrop.appendChild(dialog);
  (params.doc.body || params.doc.documentElement).appendChild(backdrop);
}

export function decoratePlanDocumentCitations(params: {
  doc: Document;
  root: HTMLElement;
  document: PlanDocument;
}): void {
  const singleSourceByText = new Map(
    params.document.citationBundle.clusters
      .filter((cluster) => cluster.sources.length === 1 && cluster.text.trim())
      .map((cluster) => [cluster.text.trim(), cluster.sources[0]]),
  );
  const sources = params.document.citationBundle.clusters.flatMap(
    (cluster) => cluster.sources,
  );
  const sourceByHref = new Map<string, PlanCitationSource>();
  for (const source of sources) {
    const hrefs = [
      planDocumentCitationSourceHref(source),
      planDocumentCitationSourceHref({ ...source, locator: undefined }),
    ];
    for (const href of hrefs) {
      sourceByHref.set(href, source);
      try {
        sourceByHref.set(decodeURI(href), source);
      } catch {
        // The raw URI remains the canonical lookup key.
      }
    }
  }
  for (const node of Array.from(params.root.querySelectorAll("a"))) {
    const link = node as HTMLAnchorElement;
    const href = link.getAttribute("href") || "";
    let decodedHref = href;
    try {
      decodedHref = decodeURI(href);
    } catch {
      decodedHref = href;
    }
    const source =
      sourceByHref.get(href) ||
      sourceByHref.get(decodedHref) ||
      singleSourceByText.get((link.textContent || "").trim());
    if (!source) continue;
    link.dataset.llmPlanCitationSource = "true";
    link.title = "Open cited Zotero source";
    attachSourceNavigation(link, source);
  }

  const showText = params.doc.defaultView?.NodeFilter?.SHOW_TEXT || 4;
  for (const cluster of params.document.citationBundle.clusters) {
    if (cluster.sources.length < 2 || !cluster.text) continue;
    const walker = params.doc.createTreeWalker(params.root, showText);
    let textNode: Node | null = null;
    while ((textNode = walker.nextNode())) {
      const text = textNode.nodeValue || "";
      const offset = text.indexOf(cluster.text);
      if (offset < 0 || !textNode.parentNode) continue;
      const fragment = params.doc.createDocumentFragment();
      if (offset) fragment.append(text.slice(0, offset));
      const button = params.doc.createElement("button");
      button.type = "button";
      button.className = "llm-plan-document-citation-cluster";
      button.textContent = cluster.text;
      button.title = "View citation sources";
      button.addEventListener("click", () =>
        showCitationSourceChooser({ doc: params.doc, cluster }),
      );
      fragment.appendChild(button);
      if (offset + cluster.text.length < text.length) {
        fragment.append(text.slice(offset + cluster.text.length));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
      break;
    }
  }
}

export function renderPlanDocumentFigures(
  doc: Document,
  document: PlanDocument,
): HTMLElement | null {
  if (!document.assets.length) return null;
  const gallery = doc.createElement("section");
  gallery.className = "llm-plan-document-figures";
  for (const asset of document.assets) {
    const figure = doc.createElement("figure");
    figure.className = "llm-plan-document-figure";
    const image = doc.createElement("img");
    image.src = toFileUrl(asset.durablePath) || "";
    image.alt = asset.caption;
    if (asset.width) image.width = asset.width;
    if (asset.height) image.height = asset.height;
    image.loading = "lazy";
    const caption = doc.createElement("figcaption");
    caption.textContent = asset.caption;
    const provenance = doc.createElement("span");
    provenance.textContent =
      asset.provenance.origin === "extracted"
        ? `Extracted from ${getPlanDocumentItemTitle(
            asset.provenance.libraryID,
            asset.provenance.itemKey,
          )}, PDF page ${asset.provenance.pageIndex + 1}`
        : `Generated asset · ${asset.provenance.generator}`;
    caption.appendChild(provenance);
    figure.append(image, caption);
    gallery.appendChild(figure);
  }
  return gallery;
}
