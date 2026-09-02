import type {
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

  const item = Zotero.Items.getByLibraryAndKey(
    source.libraryID,
    source.itemKey,
  );
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
