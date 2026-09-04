import type {
  AgentActionCapability,
  AgentActionIntent,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
  AgentRuntimeRequest,
} from "../types";
import { operationCatalogEntry } from "../contracts/operationCatalog";
import type { WriteNoteDestination } from "../writeNoteDestination";

function operationDetails(operation: string): {
  operation: AgentActionOperation;
  capability: AgentActionCapability;
  proofDomain: AgentActionProofDomain;
} | null {
  return operationCatalogEntry(operation);
}

function parseParameters(value: unknown): AgentActionParameters | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : undefined;
  const stringArray = (key: string): string[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length ? values : undefined;
  };
  const numberArray = (key: string): number[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    return values.length ? values : undefined;
  };
  const stringValue = (key: string): string | undefined =>
    typeof record[key] === "string" && String(record[key]).trim()
      ? String(record[key]).trim()
      : undefined;
  const positiveNumber = (key: string): number | undefined => {
    const number = Number(record[key]);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  };
  const parameters: AgentActionParameters = {
    ...(tags?.length ? { tags } : {}),
    ...(stringArray("metadataFields")
      ? { metadataFields: stringArray("metadataFields") }
      : {}),
    ...(stringValue("tag") ? { tag: stringValue("tag") } : {}),
    ...(stringValue("newTag") ? { newTag: stringValue("newTag") } : {}),
    ...(stringValue("collectionName")
      ? { collectionName: stringValue("collectionName") }
      : {}),
    ...(stringValue("filePath") ? { filePath: stringValue("filePath") } : {}),
    ...(stringValue("newName") ? { newName: stringValue("newName") } : {}),
    ...(stringValue("newPath") ? { newPath: stringValue("newPath") } : {}),
    ...(stringValue("savedSearchName")
      ? { savedSearchName: stringValue("savedSearchName") }
      : {}),
    ...(stringArray("identifiers")
      ? { identifiers: stringArray("identifiers") }
      : {}),
    ...(stringArray("filePaths")
      ? { filePaths: stringArray("filePaths") }
      : {}),
    ...(stringValue("contentHash")
      ? { contentHash: stringValue("contentHash") }
      : {}),
    ...(stringValue("settingsKey")
      ? { settingsKey: stringValue("settingsKey") }
      : {}),
    ...(stringValue("settingsValue")
      ? { settingsValue: stringValue("settingsValue") }
      : {}),
    ...(positiveNumber("destinationCollectionId")
      ? { destinationCollectionId: positiveNumber("destinationCollectionId") }
      : {}),
    ...(positiveNumber("collectionId")
      ? { collectionId: positiveNumber("collectionId") }
      : {}),
    ...(positiveNumber("savedSearchId")
      ? { savedSearchId: positiveNumber("savedSearchId") }
      : {}),
    ...(numberArray("collectionIds")
      ? { collectionIds: numberArray("collectionIds") }
      : {}),
    ...(positiveNumber("targetItemId")
      ? { targetItemId: positiveNumber("targetItemId") }
      : {}),
    ...(positiveNumber("targetNoteId")
      ? { targetNoteId: positiveNumber("targetNoteId") }
      : {}),
    ...(record.pageIndex === 0 || positiveNumber("pageIndex")
      ? { pageIndex: Math.max(0, Math.floor(Number(record.pageIndex))) }
      : {}),
    ...(positiveNumber("revertCount")
      ? { revertCount: positiveNumber("revertCount") }
      : {}),
    ...(record.parentCollectionId === null
      ? { parentCollectionId: null }
      : positiveNumber("parentCollectionId")
        ? { parentCollectionId: positiveNumber("parentCollectionId") }
        : {}),
    ...(record.sourceCollectionId === "all"
      ? { sourceCollectionId: "all" as const }
      : positiveNumber("sourceCollectionId")
        ? { sourceCollectionId: positiveNumber("sourceCollectionId") }
        : {}),
    ...(record.noteMode === "create" ||
    record.noteMode === "edit" ||
    record.noteMode === "append"
      ? { noteMode: record.noteMode }
      : {}),
    ...(record.semanticAction === "add" ||
    record.semanticAction === "remove" ||
    record.semanticAction === "rename" ||
    record.semanticAction === "merge" ||
    record.semanticAction === "delete" ||
    record.semanticAction === "setColor"
      ? { semanticAction: record.semanticAction }
      : {}),
    ...(typeof record.deleteItems === "boolean"
      ? { deleteItems: record.deleteItems }
      : {}),
    ...(typeof record.permanent === "boolean"
      ? { permanent: record.permanent }
      : {}),
  };
  return Object.keys(parameters).length ? parameters : undefined;
}

function parseActionIntent(value: unknown): AgentActionIntent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const details =
    typeof record.operation === "string"
      ? operationDetails(record.operation)
      : null;
  if (!details) return null;
  if (
    record.coverage !== "one" &&
    record.coverage !== "some" &&
    record.coverage !== "all"
  ) {
    return null;
  }
  const rawScope = record.scope;
  const scope =
    rawScope &&
    typeof rawScope === "object" &&
    (rawScope as { kind?: unknown }).kind === "collection"
      ? {
          kind: "collection" as const,
          path:
            typeof (rawScope as { path?: unknown }).path === "string" &&
            (rawScope as { path: string }).path.trim()
              ? (rawScope as { path: string }).path.trim()
              : undefined,
          includeDescendants:
            (rawScope as { includeDescendants?: unknown })
              .includeDescendants === true,
        }
      : undefined;
  const constraintsValue = record.constraints;
  const constraintsRecord =
    constraintsValue && typeof constraintsValue === "object"
      ? (constraintsValue as Record<string, unknown>)
      : {};
  const tagPrefix =
    typeof constraintsRecord.tagPrefix === "string"
      ? constraintsRecord.tagPrefix.trim()
      : "";
  const readMode = constraintsRecord.readMode === "full" ? "full" : undefined;
  const collectionMode =
    constraintsRecord.collectionMode === "move" ? "move" : undefined;
  return {
    ...details,
    coverage: record.coverage,
    targetKind: record.targetKind === "items" ? "items" : "papers",
    scopeRole: record.scopeRole === "destination" ? "destination" : "source",
    parameters: parseParameters(record.parameters),
    ...(scope ? { scope } : {}),
    ...(tagPrefix || readMode || collectionMode
      ? {
          constraints: {
            ...(tagPrefix ? { tagPrefix } : {}),
            ...(readMode ? { readMode } : {}),
            ...(collectionMode ? { collectionMode } : {}),
          },
        }
      : {}),
  };
}

export function parseActionIntents(value: unknown): AgentActionIntent[] {
  return Array.isArray(value)
    ? value
        .map(parseActionIntent)
        .filter((intent): intent is AgentActionIntent => Boolean(intent))
    : [];
}

function actionIntentKey(intent: AgentActionIntent): string {
  return [
    intent.operation,
    intent.coverage,
    intent.targetKind,
    intent.scope?.path || "",
    intent.scope?.includeDescendants ? "descendants" : "direct",
    intent.scopeRole || "source",
    JSON.stringify(intent.parameters || {}),
  ].join("|");
}

export function mergeActionIntents(
  primary: AgentActionIntent[],
  secondary: AgentActionIntent[],
): AgentActionIntent[] {
  const merged = new Map<string, AgentActionIntent>();
  for (const intent of [...primary, ...secondary]) {
    const key = actionIntentKey(intent);
    if (!merged.has(key)) merged.set(key, intent);
  }
  return [...merged.values()];
}

export function reconcileNoteDestinationActionIntents(
  intents: AgentActionIntent[],
  destination: WriteNoteDestination,
): AgentActionIntent[] {
  if (destination === "none") return intents;
  const wantsFile = destination === "file" || destination === "both";
  const wantsZotero = destination === "zotero" || destination === "both";
  const isZoteroNote = (intent: AgentActionIntent) =>
    intent.operation === "note_create" ||
    intent.operation === "note_edit" ||
    intent.operation === "note_append";
  const retained = intents.filter(
    (intent) =>
      (intent.operation !== "file_write" || wantsFile) &&
      (!isZoteroNote(intent) || wantsZotero),
  );
  const additions: AgentActionIntent[] = [];
  if (
    wantsFile &&
    !retained.some((intent) => intent.operation === "file_write")
  ) {
    additions.push({
      operation: "file_write",
      proofDomain: "file_state",
      capability: "file.write",
      coverage: "one",
      targetKind: "items",
    });
  }
  if (wantsZotero && !retained.some(isZoteroNote)) {
    additions.push({
      operation: "note_create",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      coverage: "one",
      targetKind: "items",
      parameters: { noteMode: "create" },
    });
  }
  return mergeActionIntents(retained, additions);
}

function requestedCoverage(text: string): AgentActionIntent["coverage"] {
  if (
    /\b(?:all|every|each|todos?|todas?|cada)\b|(?:全部|所有|每一|すべて|全て|各)/i.test(
      text,
    )
  )
    return "all";
  if (
    /\b(?:this|current|one|single|este|esta|actual|uno|una)\b|(?:这个|這個|当前|當前|一个|一個|この|現在|1つ)/i.test(
      text,
    )
  )
    return "one";
  return "some";
}

function requestedCollectionScope(
  request: Pick<AgentRuntimeRequest, "userText" | "turnPaperScope">,
): AgentActionIntent["scope"] | undefined {
  const text = request.userText || "";
  const named = text.match(
    /\b(?:collection|folder)\s+(?:named\s+)?["“']([^"”']+)["”']/i,
  )?.[1];
  if (!named && !request.turnPaperScope.collections.length) return undefined;
  return {
    kind: "collection",
    ...(named && !request.turnPaperScope.collections.length
      ? { path: named.trim() }
      : {}),
    includeDescendants:
      /\b(?:subcollections?|descendants?|including children)\b/i.test(text),
  };
}

function quotedValueAfter(text: string, noun: string): string | undefined {
  return text
    .match(
      new RegExp(`\\b${noun}\\s+(?:named\\s+)?["“']([^"”']+)["”']`, "i"),
    )?.[1]
    ?.trim();
}

function requestedFilePath(text: string): string | undefined {
  const quoted = text.match(/["“'](\/[^"”'\r\n]+\.[A-Za-z0-9]+)["”']/)?.[1];
  if (quoted) return quoted.trim();
  return text
    .match(/(?:^|\s)(\/[^\s"'<>|]+\.[A-Za-z0-9]+)(?=\s|$)/)?.[1]
    ?.trim();
}

function mutationRequestIsExplicit(text: string): boolean {
  if (
    /\b(?:do not|don't|dont|never|without (?:changing|modifying|writing)|only a question|hypothetical|for advice)\b|(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)|(?:しないで|しない|するな|禁止)|^\s*(?:no|nunca|sin)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /^\s*(?:what|which|why|how|should|would|could|if|qu[eé]|cu[aá]l|por\s+qu[eé]|c[oó]mo|deber[ií]a|podr[ií]a|si)\b|^\s*(?:什么|什麼|哪个|哪個|为什么|為什麼|如何|怎么|怎麼|是否|能否|なに|何|どれ|なぜ|どう|どの)/i.test(
      text,
    )
  ) {
    return false;
  }
  return [
    /^\s*(?:please\s+)?(?:add|apply|assign|remove|replace|set|tag|update|edit|change|correct|create|write|save|append|import|trash|restore|delete|rename|relink|move|file|merge|relate|unrelate|annotate|undo|revert|run|execute|export)\b/i,
    /^\s*(?:请|請)?\s*(?:添加|新增|应用|應用|分配|移除|替换|替換|设置|設定|加标签|加標籤|更新|编辑|編輯|更改|修正|创建|創建|建立|写入|寫入|保存|儲存|追加|导入|匯入|放入回收站|恢复|還原|删除|刪除|重命名|重新命名|重新链接|重新連結|移动|移動|归档|歸檔|合并|合併|关联|關聯|取消关联|取消關聯|标注|標註|撤销|復原|运行|運行|执行|執行|导出|匯出)/i,
    /(?:追加|適用|割り当て|除去|置換|設定|タグ付け|更新|編集|変更|修正|作成|書き込|保存|追記|インポート|ゴミ箱|復元|削除|名前変更|再リンク|移動|整理|統合|関連付け|注釈|元に戻|実行|エクスポート)(?:して|してください|せよ)/i,
    /^\s*(?:por\s+favor\s+)?(?:agrega|a[nñ]ade|aplica|asigna|quita|reemplaza|establece|etiqueta|actualiza|edita|cambia|corrige|crea|escribe|guarda|anexa|importa|elimina|renombra|mueve|archiva|combina|relaciona|anota|deshaz|revierte|ejecuta|exporta)\b/i,
  ].some((pattern) => pattern.test(text));
}

/** High-confidence fallback used only when the classifier call fails. */
export function inferActionIntentsFromRequest(
  request: Pick<AgentRuntimeRequest, "userText" | "turnPaperScope">,
): AgentActionIntent[] {
  const text = (request.userText || "").trim();
  if (!text) return [];
  const coverage = requestedCoverage(text);
  const scope = requestedCollectionScope(request);
  const intents: AgentActionIntent[] = [];
  const add = (
    operation: AgentActionOperation,
    parameters?: AgentActionParameters,
    options: Partial<
      Pick<
        AgentActionIntent,
        "targetKind" | "scopeRole" | "scope" | "constraints"
      >
    > = {},
  ) => {
    const details = operationDetails(operation);
    if (!details) return;
    intents.push({
      ...details,
      coverage,
      targetKind: options.targetKind || "papers",
      scopeRole: options.scopeRole || "source",
      scope: Object.prototype.hasOwnProperty.call(options, "scope")
        ? options.scope
        : scope,
      parameters,
      constraints: options.constraints,
    });
  };

  if (mutationRequestIsExplicit(text)) {
    const tagSegment = text.split(
      /\b(?:to|in|for)\s+(?:the\s+)?(?:collection|folder)\b/i,
    )[0];
    const tags = [...tagSegment.matchAll(/["“']([^"”']+)["”']/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    if (
      /\b(?:add|apply|assign|tag)\b[\s\S]{0,60}\btags?\b|^\s*(?:please\s+)?tag\b|(?:添加|新增|应用|應用|加上|加)[^。！？\n]{0,40}(?:标签|標籤)|(?:タグ)[^。！？\n]{0,30}(?:追加|付け)|(?:agrega|a[nñ]ade|aplica|asigna)[^.!?\n]{0,40}\betiquetas?\b/i.test(
        text,
      )
    ) {
      add("apply_tags", tags.length ? { tags } : undefined);
    } else if (/\bremove\b[\s\S]{0,60}\btags?\b/i.test(text)) {
      add("remove_tags", tags.length ? { tags } : undefined);
    } else if (/\b(?:replace|set)\b[\s\S]{0,60}\btags?\b/i.test(text)) {
      add("set_item_tags", tags.length ? { tags } : undefined);
    }

    if (
      /^\s*(?:please\s+)?create\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add(
        "create_collection",
        {
          collectionName: quotedValueAfter(text, "(?:collection|folder)"),
        },
        { targetKind: "items", scope: undefined },
      );
    } else if (
      /^\s*(?:please\s+)?delete\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("delete_collection", undefined, {
        targetKind: "items",
      });
    } else if (
      /^\s*(?:please\s+)?(?:rename|move)\b[\s\S]{0,50}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("update_collection", undefined, {
        targetKind: "items",
      });
    } else if (
      /\b(?:move|file|add)\b[\s\S]{0,60}\b(?:papers?|items?)\b[\s\S]{0,60}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("move_to_collection", undefined, {
        targetKind: "items",
        constraints: /\bmove\b/i.test(text)
          ? { collectionMode: "move" }
          : undefined,
      });
    } else if (
      /\bremove\b[\s\S]{0,60}\b(?:papers?|items?)\b[\s\S]{0,60}\b(?:collection|folder)\b/i.test(
        text,
      )
    ) {
      add("remove_from_collection", undefined, { targetKind: "items" });
    }

    if (
      /\b(?:update|edit|change|correct|set|replace|enrich)\b[\s\S]{0,100}\b(?:metadata|fields?|extra|title|abstract|doi|date|year|authors?|creators?|publication)\b/i.test(
        text,
      )
    ) {
      add("update_metadata");
    }
    if (
      /\b(?:create|write|save)\b[\s\S]{0,50}\bnotes?\b|(?:创建|創建|建立|写入|寫入|保存|儲存)[^。！？\n]{0,40}(?:zotero\s*)?(?:笔记|筆記)|(?:zotero\s*)?ノート[^。！？\n]{0,30}(?:作成|書き込|保存)|(?:crea|escribe|guarda)[^.!?\n]{0,40}\b(?:una?\s+)?notas?\b/i.test(
        text,
      )
    ) {
      add("note_create", { noteMode: "create" }, { targetKind: "items" });
    } else if (/\bappend\b[\s\S]{0,50}\bnotes?\b/i.test(text)) {
      add("note_append", { noteMode: "append" }, { targetKind: "items" });
    } else if (
      /\b(?:edit|update|replace)\b[\s\S]{0,50}\bnotes?\b/i.test(text)
    ) {
      add("note_edit", { noteMode: "edit" }, { targetKind: "items" });
    }
    if (/\bimport\b[\s\S]{0,50}\b(?:files?|pdfs?)\b/i.test(text)) {
      add("import_local_files", undefined, {
        targetKind: "items",
        scopeRole: "destination",
      });
    } else if (
      /\bimport\b[\s\S]{0,50}\b(?:doi|isbn|pmid|arxiv|identifiers?)\b/i.test(
        text,
      )
    ) {
      add("import_identifiers", undefined, {
        targetKind: "items",
        scopeRole: "destination",
      });
    }
    if (/\btrash\b[\s\S]{0,40}\b(?:papers?|items?|entries)\b/i.test(text)) {
      add("trash_items", undefined, { targetKind: "items" });
    } else if (
      /\b(?:restore|undelete)\b[\s\S]{0,40}\b(?:papers?|items?|entries)\b/i.test(
        text,
      )
    ) {
      add("restore_from_trash", undefined, { targetKind: "items" });
    } else if (
      /\bmerge\b[\s\S]{0,40}\b(?:papers?|items?|entries|duplicates?)\b/i.test(
        text,
      )
    ) {
      add("merge_items", undefined, { targetKind: "items" });
    }
    if (/\bdelete\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("delete_attachment", undefined, { targetKind: "items" });
    } else if (/\brename\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("rename_attachment", undefined, { targetKind: "items" });
    } else if (/\brelink\b[\s\S]{0,40}\battachments?\b/i.test(text)) {
      add("relink_attachment", undefined, { targetKind: "items" });
    }
    if (/\bannotate\b[\s\S]{0,50}\b(?:pdf|paper|document)\b/i.test(text)) {
      add("annotation_write", undefined, { targetKind: "items" });
    }
    if (/^\s*(?:please\s+)?undo\b/i.test(text))
      add("undo", undefined, { targetKind: "items", scope: undefined });
    if (/^\s*(?:please\s+)?revert\b/i.test(text))
      add("revert", undefined, { targetKind: "items", scope: undefined });
    if (
      /\b(?:write|save|export)\b[\s\S]{0,80}\b(?:file|markdown|csv|json|vault)\b|(?:写入|寫入|保存|儲存|导出|匯出)[^。！？\n]{0,60}(?:文件|檔案|markdown|csv|json)|(?:ファイル|markdown|csv|json)[^。！？\n]{0,40}(?:書き込|保存|エクスポート)|(?:escribe|guarda|exporta)[^.!?\n]{0,60}\b(?:archivo|markdown|csv|json)\b/i.test(
        text,
      )
    ) {
      const filePath = requestedFilePath(text);
      add("file_write", filePath ? { filePath } : undefined, {
        targetKind: "items",
        scope: undefined,
      });
    }
    if (
      /^\s*(?:please\s+)?(?:run|execute)\b[\s\S]{0,40}\b(?:command|shell)\b|(?:运行|運行|执行|執行)[^。！？\n]{0,30}(?:命令|指令|shell)|(?:コマンド|シェル)[^。！？\n]{0,24}(?:実行)|(?:ejecuta|ejecutar)[^.!?\n]{0,30}\b(?:comando|shell)\b/i.test(
        text,
      )
    ) {
      add("command_execute", undefined, {
        targetKind: "items",
        scope: undefined,
      });
    } else if (
      /^\s*(?:please\s+)?(?:run|execute)\b[\s\S]{0,40}\bzotero\b[\s\S]{0,20}\bscript\b/i.test(
        text,
      )
    ) {
      add("zotero_script_execute", undefined, {
        targetKind: "items",
        scope: undefined,
      });
    }
  }

  if (
    /^\s*(?:please\s+)?(?:read|review|analy[sz]e|inspect)\b[\s\S]{0,50}\b(?:full|entire|complete|exhaustive)\b[\s\S]{0,30}\b(?:paper|text|pdf|document)\b/i.test(
      text,
    )
  ) {
    add("read_full", undefined, { constraints: { readMode: "full" } });
  }
  return mergeActionIntents([], intents);
}
