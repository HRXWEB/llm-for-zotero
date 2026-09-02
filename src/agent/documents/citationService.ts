import type { ZoteroGateway } from "../services/zoteroGateway";
import type { ResearchEvidenceRecord } from "../research/types";
import type { ResearchScopeSnapshotItem } from "../research/types";
import type {
  DocumentSpec,
  FormattedCitationBundle,
  PlanCitationCluster,
  PlanCitationSource,
} from "./types";

const CITATION_TOKEN = /\[\[cite:([A-Za-z0-9._:-]+)\]\]/g;

function sourceKey(source: Pick<PlanCitationSource, "libraryID" | "itemKey">) {
  return `${source.libraryID}:${source.itemKey}`;
}

function itemByLibraryAndKey(
  libraryID: number,
  itemKey: string,
): Zotero.Item | null {
  const items = Zotero.Items as unknown as {
    getByLibraryAndKey?: (
      libraryID: number,
      itemKey: string,
    ) => Zotero.Item | false | undefined;
  };
  return items.getByLibraryAndKey?.(libraryID, itemKey) || null;
}

function libraryPath(libraryID: number): string {
  if (libraryID === Number(Zotero.Libraries.userLibraryID)) return "library";
  const library = Zotero.Libraries.get(libraryID) as
    | { groupID?: number }
    | undefined;
  return library?.groupID ? `groups/${library.groupID}` : "library";
}

export function buildZoteroItemUri(libraryID: number, itemKey: string): string {
  return `zotero://select/${libraryPath(libraryID)}/items/${itemKey}`;
}

export function buildPlanCitationSourceUri(source: PlanCitationSource): string {
  if (source.locator) {
    return `zotero://open-pdf/${libraryPath(source.libraryID)}/items/${source.locator.attachmentItemKey}?page=${source.locator.pageIndex + 1}`;
  }
  return buildZoteroItemUri(source.libraryID, source.itemKey);
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/(\[|\])/g, "\\$1");
}

function normalizeOutput(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validateLocator(params: {
  source: PlanCitationSource;
  evidence: readonly ResearchEvidenceRecord[];
}): void {
  if (!params.source.locator) return;
  const trusted = params.evidence.some(
    (record) =>
      record.version === 2 &&
      Boolean(record.observationId) &&
      params.source.evidenceRefs.includes(record.evidenceRef) &&
      record.libraryID === params.source.libraryID &&
      record.itemKey === params.source.itemKey &&
      record.locator?.attachmentItemKey ===
        params.source.locator?.attachmentItemKey &&
      record.locator?.pageIndex === params.source.locator?.pageIndex &&
      record.locator?.sourceFingerprint ===
        params.source.locator?.sourceFingerprint,
  );
  if (!trusted) {
    throw new Error(
      `Citation locator for ${params.source.itemKey} is not backed by trusted evidence`,
    );
  }
}

export function formatPlanDocumentCitations(params: {
  gateway: ZoteroGateway;
  draftMarkdown: string;
  clusters: readonly PlanCitationCluster[];
  corpus: readonly ResearchScopeSnapshotItem[];
  evidence: readonly ResearchEvidenceRecord[];
  spec: DocumentSpec;
}): {
  visibleMarkdown: string;
  citationBundle: FormattedCitationBundle;
} {
  const corpusKeys = new Set(params.corpus.map(sourceKey));
  const evidenceByRef = new Map(
    params.evidence.map((record) => [record.evidenceRef, record]),
  );
  const clustersById = new Map<string, PlanCitationCluster>();
  const resolved = params.clusters.map((cluster) => {
    if (!cluster.citationId.trim() || clustersById.has(cluster.citationId)) {
      throw new Error(`Duplicate or empty citation ID: ${cluster.citationId}`);
    }
    if (!cluster.sources.length) {
      throw new Error(`Citation ${cluster.citationId} has no sources`);
    }
    const sourceKeys = cluster.sources.map(sourceKey);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new Error(
        `Citation ${cluster.citationId} contains duplicate sources`,
      );
    }
    clustersById.set(cluster.citationId, cluster);
    const items = cluster.sources.map((source) => {
      if (!corpusKeys.has(sourceKey(source))) {
        throw new Error(
          `Citation ${cluster.citationId} references an item outside the approved corpus`,
        );
      }
      if (!source.evidenceRefs.length) {
        throw new Error(
          `Citation ${cluster.citationId} requires at least one evidence reference`,
        );
      }
      for (const evidenceRef of source.evidenceRefs) {
        const evidence = evidenceByRef.get(evidenceRef);
        if (
          !evidence ||
          evidence.version !== 2 ||
          !evidence.observationId ||
          evidence.libraryID !== source.libraryID ||
          evidence.itemKey !== source.itemKey
        ) {
          throw new Error(
            `Citation ${cluster.citationId} has an invalid evidence reference`,
          );
        }
      }
      validateLocator({ source, evidence: params.evidence });
      const item = itemByLibraryAndKey(source.libraryID, source.itemKey);
      if (!item || item.isNote?.()) {
        throw new Error(
          `Citation ${cluster.citationId} does not resolve to a citable Zotero item`,
        );
      }
      return {
        itemId: Number(item.id),
        pageIndex: source.locator?.pageIndex,
      };
    });
    return { citationId: cluster.citationId, items };
  });

  const tokenIds: string[] = [];
  for (const match of params.draftMarkdown.matchAll(CITATION_TOKEN)) {
    tokenIds.push(match[1]);
  }
  if (!tokenIds.length && params.clusters.length) {
    throw new Error(
      "Citation mappings were supplied but the document has no citation tokens",
    );
  }
  for (const citationId of tokenIds) {
    if (!clustersById.has(citationId)) {
      throw new Error(
        `Document contains unresolved citation token ${citationId}`,
      );
    }
  }
  for (const citationId of clustersById.keys()) {
    if (!tokenIds.includes(citationId)) {
      throw new Error(`Citation ${citationId} is not used in the document`);
    }
  }
  if (/^#{1,6}\s+references\s*$/im.test(params.draftMarkdown)) {
    throw new Error(
      "Do not hand-write References; the host generates them from cited Zotero items",
    );
  }
  if (!params.clusters.length) {
    if (params.spec.requiresReferences) {
      throw new Error(
        "The approved document requires References but contains no citations",
      );
    }
    return {
      visibleMarkdown: params.draftMarkdown,
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: {
          id: params.spec.citationStyle.styleId,
          title: params.spec.citationStyle.styleTitle,
        },
        locale: params.spec.citationStyle.locale,
      },
    };
  }

  const formatted = params.gateway.formatStructuredCitations({
    clusters: resolved,
    styleId: params.spec.citationStyle.styleId,
    locale: params.spec.citationStyle.locale,
  });
  const sourceByItemId = new Map<number, PlanCitationSource>();
  for (const cluster of params.clusters) {
    for (const source of cluster.sources) {
      const item = itemByLibraryAndKey(source.libraryID, source.itemKey);
      if (item) sourceByItemId.set(Number(item.id), source);
    }
  }
  const formattedClusters = formatted.clusters.map((cluster) => ({
    citationId: cluster.citationId,
    text: normalizeOutput(cluster.text),
    html: cluster.html,
    sources: clustersById.get(cluster.citationId)!.sources,
  }));
  const clusterById = new Map(
    formattedClusters.map((cluster) => [cluster.citationId, cluster]),
  );
  let visibleMarkdown = params.draftMarkdown.replace(
    CITATION_TOKEN,
    (_token, citationId: string) => {
      const cluster = clusterById.get(citationId);
      if (!cluster) throw new Error(`Citation ${citationId} was not formatted`);
      if (cluster.sources.length !== 1) {
        const sourceLinks = cluster.sources
          .map(
            (source, index) =>
              `[${index + 1}](${buildPlanCitationSourceUri(source)})`,
          )
          .join(" ");
        return `${cluster.text} ${sourceLinks}`;
      }
      return `[${escapeMarkdownLabel(cluster.text)}](${buildPlanCitationSourceUri(cluster.sources[0])})`;
    },
  );
  CITATION_TOKEN.lastIndex = 0;
  if (CITATION_TOKEN.test(visibleMarkdown)) {
    throw new Error("Internal citation tokens remain after serialization");
  }
  CITATION_TOKEN.lastIndex = 0;
  const bibliographyEntries = formatted.bibliographyEntries.map((entry) => {
    const source = sourceByItemId.get(entry.itemId);
    if (!source) {
      throw new Error(
        "A bibliography entry could not be paired with its Zotero item",
      );
    }
    return {
      libraryID: source.libraryID,
      itemKey: source.itemKey,
      text: normalizeOutput(entry.text),
      html: entry.html,
    };
  });
  if (params.spec.requiresReferences) {
    const references = bibliographyEntries
      .map(
        (entry) =>
          `- [${escapeMarkdownLabel(entry.text)}](${buildZoteroItemUri(entry.libraryID, entry.itemKey)})`,
      )
      .join("\n");
    visibleMarkdown = `${visibleMarkdown.trimEnd()}\n\n## References\n\n${references}\n`;
  }
  return {
    visibleMarkdown,
    citationBundle: {
      clusters: formattedClusters,
      bibliographyEntries,
      style: { id: formatted.styleId, title: formatted.styleTitle },
      locale: formatted.locale,
    },
  };
}
