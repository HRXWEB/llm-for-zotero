import { createFinalizedZoteroNote } from "../../modules/contextPanel/notePersistence";
import { importNoteImageAsset } from "../../modules/contextPanel/noteImages";
import { escapeNoteHtml } from "../../modules/contextPanel/textUtils";
import { loadPlanArtifact } from "../plans/store";
import { sha256Bytes } from "../store/journalRecoveryBlobStore";
import {
  loadDocumentActionState,
  loadPlanDocument,
  saveDocumentActionState,
} from "./store";
import {
  getPlannedDocumentOrigin,
  type DocumentActionState,
  type PlanDocument,
} from "./types";

function resolveItemByKey(
  libraryID: number,
  itemKey: string,
): Zotero.Item | null {
  return Zotero.Items.getByLibraryAndKey(libraryID, itemKey) || null;
}

function citedItems(document: PlanDocument): Array<{
  libraryID: number;
  itemKey: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ libraryID: number; itemKey: string }> = [];
  for (const cluster of document.citationBundle.clusters) {
    for (const source of cluster.sources) {
      const key = `${source.libraryID}:${source.itemKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ libraryID: source.libraryID, itemKey: source.itemKey });
    }
  }
  return out;
}

export async function savePlanDocumentAsNote(documentId: string): Promise<{
  libraryID: number;
  itemKey: string;
  itemId: number;
  created: boolean;
  warnings: string[];
}> {
  const document = await loadPlanDocument(documentId);
  if (!document) throw new Error("Document not found");
  const prior = await loadDocumentActionState(documentId);
  if (prior?.savedNote) {
    const existing = resolveItemByKey(
      prior.savedNote.libraryID,
      prior.savedNote.itemKey,
    );
    if (existing && existing.isNote() && !existing.deleted) {
      return {
        libraryID: existing.libraryID,
        itemKey: existing.key,
        itemId: existing.id,
        created: false,
        warnings: [],
      };
    }
  }

  const planned = getPlannedDocumentOrigin(document);
  const artifact = planned
    ? await loadPlanArtifact(planned.planId, planned.planRevision)
    : null;
  const cited = citedItems(document);
  const singleParent =
    cited.length === 1
      ? resolveItemByKey(cited[0].libraryID, cited[0].itemKey)
      : null;
  const scope = artifact?.contract?.investigation?.scope;
  const libraryID =
    singleParent?.libraryID ||
    scope?.libraryID ||
    cited[0]?.libraryID ||
    Zotero.Libraries.userLibraryID;
  const note = new Zotero.Item("note");
  note.libraryID = libraryID;
  if (singleParent && !singleParent.deleted) {
    note.parentID = singleParent.id;
  } else if (
    scope &&
    (scope.kind === "collections" || scope.kind === "mixed") &&
    scope.collectionIds?.length === 1
  ) {
    note.addToCollection(scope.collectionIds[0]);
  }
  const persisted = await createFinalizedZoteroNote({
    note,
    initialHtml: document.visibleHtml,
    finalize: document.assets.length
      ? async ({ noteId, saveOptions }) => {
          const blocks: string[] = [];
          const warnings: string[] = [];
          for (const asset of document.assets) {
            const bytes = await readVerifiedAssetBytes(asset);
            const imported = await importNoteImageAsset({
              noteItemId: noteId,
              bytes,
              mimeType: asset.mimeType,
              saveOptions,
            });
            if (!imported?.key) {
              warnings.push(`Figure ${asset.assetId} could not be embedded`);
              continue;
            }
            blocks.push(
              `<figure><img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(asset.caption)}" /><figcaption>${escapeNoteHtml(asset.caption)}</figcaption></figure>`,
            );
          }
          return {
            html: blocks.length
              ? `${document.visibleHtml}<h2>Figures</h2>${blocks.join("")}`
              : document.visibleHtml,
            warnings,
          };
        }
      : undefined,
    log: (message, error) => ztoolkit.log(message, error),
  });
  const created = Zotero.Items.get(persisted.noteId) || note;
  if (!created.key) throw new Error("Created note has no stable Zotero key");
  const now = Date.now();
  const nextState: DocumentActionState = {
    version: 1,
    documentId,
    savedNote: { libraryID: created.libraryID, itemKey: created.key },
    lastExportedAt: prior?.lastExportedAt,
    lastExportedName: prior?.lastExportedName,
    updatedAt: now,
  };
  await saveDocumentActionState(nextState);
  return {
    libraryID: created.libraryID,
    itemKey: created.key,
    itemId: created.id,
    created: true,
    warnings: [...persisted.warnings],
  };
}

async function readVerifiedAssetBytes(
  asset: PlanDocument["assets"][number],
): Promise<Uint8Array> {
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (typeof io?.read !== "function") {
    throw new Error(
      "Document asset storage is unavailable in this Zotero build",
    );
  }
  const source = await io.read(asset.durablePath);
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const checksum = await sha256Bytes(bytes);
  const expected = asset.contentHash.replace(/^sha256:/, "");
  if (checksum !== expected || bytes.byteLength !== asset.byteLength) {
    throw new Error(
      `Document asset ${asset.assetId} failed integrity validation`,
    );
  }
  return bytes;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function pathParts(path: string): { directory: string; stem: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = slash >= 0 ? path.slice(0, slash) : ".";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const stem = name.replace(/\.md$/i, "") || "plan-document";
  return { directory, stem };
}

export async function exportPlanDocumentMarkdown(
  documentId: string,
  requestedPath: string,
): Promise<string> {
  const document = await loadPlanDocument(documentId);
  if (!document) throw new Error("Document not found");
  const outputPath = /\.md$/i.test(requestedPath)
    ? requestedPath
    : `${requestedPath}.md`;
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (typeof io?.write !== "function") {
    throw new Error("Atomic file export is unavailable in this Zotero build");
  }
  const verifiedAssets: Array<{
    asset: PlanDocument["assets"][number];
    bytes: Uint8Array;
    fileName: string;
  }> = [];
  if (document.assets.length) {
    for (const asset of document.assets) {
      const bytes = await readVerifiedAssetBytes(asset);
      verifiedAssets.push({
        asset,
        bytes,
        fileName: `${asset.assetId}.${extensionForMime(asset.mimeType)}`,
      });
    }
  }

  const { directory, stem } = pathParts(outputPath);
  const separator = outputPath.includes("\\") ? "\\" : "/";
  const assetDirectory = `${directory}${separator}${stem}_assets`;
  const stagedAssetDirectory = `${assetDirectory}.tmp-${document.contentHash
    .replace(/^sha256:/, "")
    .slice(0, 12)}`;
  let installedAssets = false;
  try {
    if (verifiedAssets.length) {
      if (
        typeof io.exists === "function" &&
        (await io.exists(assetDirectory))
      ) {
        throw new Error(
          `The export asset directory already exists: ${stem}_assets`,
        );
      }
      await io.remove?.(stagedAssetDirectory, {
        recursive: true,
        ignoreAbsent: true,
      });
      await io.makeDirectory(stagedAssetDirectory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      for (const entry of verifiedAssets) {
        const stagedTarget = `${stagedAssetDirectory}${separator}${entry.fileName}`;
        await io.write(stagedTarget, entry.bytes, {
          tmpPath: `${stagedTarget}.tmp`,
        });
      }
      if (typeof io.move === "function") {
        await io.move(stagedAssetDirectory, assetDirectory, {
          noOverwrite: true,
        });
      } else {
        await io.makeDirectory(assetDirectory, {
          createAncestors: true,
          ignoreExisting: false,
        });
        for (const entry of verifiedAssets) {
          const target = `${assetDirectory}${separator}${entry.fileName}`;
          await io.write(target, entry.bytes, { tmpPath: `${target}.tmp` });
        }
        await io.remove?.(stagedAssetDirectory, {
          recursive: true,
          ignoreAbsent: true,
        });
      }
      installedAssets = true;
    }
    const figureMarkdown = verifiedAssets.length
      ? `\n\n## Figures\n\n${verifiedAssets
          .map(
            ({ asset, fileName }) =>
              `![${asset.caption.replace(/\[|\]/g, "")}](${stem}_assets/${fileName})`,
          )
          .join("\n\n")}\n`
      : "";
    const bytes = new TextEncoder().encode(
      `${document.visibleMarkdown.trimEnd()}${figureMarkdown || "\n"}`,
    );
    await io.write(outputPath, bytes, { tmpPath: `${outputPath}.tmp` });
  } catch (error) {
    await io.remove?.(stagedAssetDirectory, {
      recursive: true,
      ignoreAbsent: true,
    });
    if (installedAssets) {
      await io.remove?.(assetDirectory, {
        recursive: true,
        ignoreAbsent: true,
      });
    }
    throw error;
  }

  const prior = await loadDocumentActionState(documentId);
  await saveDocumentActionState({
    version: 1,
    documentId,
    savedNote: prior?.savedNote,
    lastExportedAt: Date.now(),
    lastExportedName: outputPath.split(/[\\/]/).pop(),
    updatedAt: Date.now(),
  });
  return outputPath;
}
