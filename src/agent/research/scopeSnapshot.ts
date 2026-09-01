import type { ZoteroGateway } from "../services/zoteroGateway";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { RESEARCH_POLICY_VERSION } from "./policy";
import { saveScopeSnapshot } from "./store";
import type {
  ResearchScopeSnapshotItem,
  ResearchScopeSnapshotRef,
  ResearchScopeSpec,
} from "./types";
import type { TagContextRef } from "../../shared/types";

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

export async function getResearchItemFingerprints(
  gateway: ZoteroGateway,
  itemId: number,
): Promise<{
  metadataFingerprint: string;
  attachmentFingerprint?: string;
}> {
  const item = gateway.getItem(itemId);
  if (!item) {
    return { metadataFingerprint: "missing" };
  }
  const target = gateway.getBibliographicItemTargetsByItemIds([itemId])[0];
  const metadataFingerprint = `sha256:${await sha256Text(
    canonicalJson({
      key: String(item.key || ""),
      version: Number(
        (item as Zotero.Item & { version?: number }).version || 0,
      ),
      dateModified: String(item.getField?.("dateModified") || ""),
      title: target?.title || "",
      creators: item.getCreators?.() || [],
      tags: target?.tags || [],
    }),
  )}`;
  const attachments = await Promise.all(
    (target?.attachments || []).map(async (attachment) => {
      const attachmentItem = gateway.getItem(attachment.contextItemId) as
        | (Zotero.Item & {
            attachmentModificationTime?: number;
            attachmentSyncedModificationTime?: number;
            attachmentSyncedHash?: string;
            attachmentContentType?: string;
            getFilePathAsync?: () => Promise<string | false>;
          })
        | null;
      let fileState: { size?: number; lastModified?: number } | undefined;
      try {
        const path = await attachmentItem?.getFilePathAsync?.();
        const stat = path
          ? await (globalThis as unknown as { IOUtils?: any }).IOUtils?.stat?.(
              path,
            )
          : undefined;
        if (stat) {
          fileState = {
            size: Number.isFinite(Number(stat.size))
              ? Number(stat.size)
              : undefined,
            lastModified: Number.isFinite(Number(stat.lastModified))
              ? Number(stat.lastModified)
              : undefined,
          };
        }
      } catch {
        // Some linked or remote attachments have no local file. Zotero's own
        // attachment sync fingerprint remains part of the source identity.
      }
      return {
        key: String(attachmentItem?.key || ""),
        modified: Number(attachmentItem?.attachmentModificationTime || 0),
        syncedModified: Number(
          attachmentItem?.attachmentSyncedModificationTime || 0,
        ),
        syncedHash: String(attachmentItem?.attachmentSyncedHash || ""),
        contentType: String(attachmentItem?.attachmentContentType || ""),
        fileState,
      };
    }),
  );
  return {
    metadataFingerprint,
    attachmentFingerprint: attachments.length
      ? `sha256:${await sha256Text(canonicalJson(attachments))}`
      : undefined,
  };
}

async function resolveScopeItemIds(
  gateway: ZoteroGateway,
  scope: ResearchScopeSpec,
): Promise<number[]> {
  const explicitIds = (scope.itemKeys || [])
    .map((itemKey) => itemByLibraryAndKey(scope.libraryID, itemKey)?.id || 0)
    .filter((itemId) => itemId > 0);
  if (
    scope.kind === "library" &&
    !scope.collectionIds?.length &&
    !scope.tagNames?.length &&
    !explicitIds.length
  ) {
    const listed = await gateway.listBibliographicItemTargets({
      libraryID: scope.libraryID,
    });
    return listed.items.map((item) => item.itemId);
  }
  const tagContexts: TagContextRef[] = (scope.tagNames || []).map((name) => ({
    name,
    normalizedName: name.trim().toLowerCase(),
    libraryID: scope.libraryID,
    includeAutomatic: scope.includeAutomaticTags === true,
  }));
  const resolved = await gateway.resolveLibraryScopeItemIds({
    libraryID: scope.libraryID,
    itemIds: explicitIds,
    collectionIds: [...(scope.collectionIds || [])],
    tagContexts,
  });
  return resolved.itemIds;
}

export async function materializeResearchScopeSnapshot(params: {
  gateway: ZoteroGateway;
  planId: string;
  revision: number;
  conversationKey: number;
  scope: ResearchScopeSpec;
  now?: number;
}): Promise<{
  ref: ResearchScopeSnapshotRef;
  items: ResearchScopeSnapshotItem[];
}> {
  const createdAt = params.now ?? Date.now();
  const snapshotId = `${params.planId}:r${params.revision}:scope`;
  const targets = params.gateway.getBibliographicItemTargetsByItemIds(
    await resolveScopeItemIds(params.gateway, params.scope),
  );
  const items: ResearchScopeSnapshotItem[] = [];
  for (let ordinal = 0; ordinal < targets.length; ordinal += 1) {
    const target = targets[ordinal];
    const item = params.gateway.getItem(target.itemId);
    const itemKey = String(item?.key || "").trim();
    if (!itemKey) continue;
    const fingerprints = await getResearchItemFingerprints(
      params.gateway,
      target.itemId,
    );
    items.push({
      snapshotId,
      libraryID: params.scope.libraryID,
      itemKey,
      localItemId: target.itemId,
      ...fingerprints,
      ordinal: items.length,
    });
  }
  const digest = `sha256:${await sha256Text(
    canonicalJson(
      items.map(
        ({
          libraryID,
          itemKey,
          metadataFingerprint,
          attachmentFingerprint,
        }) => ({
          libraryID,
          itemKey,
          metadataFingerprint,
          attachmentFingerprint,
        }),
      ),
    ),
  )}`;
  const ref: ResearchScopeSnapshotRef = {
    snapshotId,
    digest,
    itemCount: items.length,
    createdAt,
    policyVersion: RESEARCH_POLICY_VERSION,
  };
  await saveScopeSnapshot({
    planId: params.planId,
    revision: params.revision,
    conversationKey: params.conversationKey,
    ref,
    items,
  });
  return { ref, items };
}
