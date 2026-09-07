import { ToolExecutionFailure } from "../execution/failure";
import { innermostToolResult } from "../../contracts/toolResultEnvelope";
import { storeRecoveryText } from "../../store/journalRecoveryBlobStore";
import type { AgentNoteChangeResultCard } from "../../types";

/** Called only after native persistence has reloaded and verified the note. */
export async function captureNoteChange(
  note: Zotero.Item,
  beforeHtml: string,
  conversationKey: number,
): Promise<Omit<AgentNoteChangeResultCard, "kind" | "actionId"> | undefined> {
  if (!note.id || !note.key || !note.libraryID) return undefined;
  const afterHtml = note.getNote();
  const [before, after] = await Promise.all([
    storeRecoveryText(beforeHtml),
    storeRecoveryText(afterHtml),
  ]);
  return {
    title: note.getNoteTitle?.() || "Note",
    note: { itemId: note.id, libraryID: note.libraryID, key: note.key },
    conversationKey,
    state: before.checksum === after.checksum ? "no_op" : "applied",
    before,
    after,
    description:
      before.checksum === after.checksum
        ? "No changes were needed."
        : "The note was updated and verified in Zotero.",
  };
}

export function buildNoteChangeResultCards(
  content: unknown,
): AgentNoteChangeResultCard[] | null {
  const result = innermostToolResult(content);
  const change = result?.noteChange as
    | Omit<AgentNoteChangeResultCard, "kind" | "actionId">
    | undefined;
  if (
    !change ||
    typeof result.actionId !== "string" ||
    !["updated", "appended", "failed"].includes(String(result.status)) ||
    !change.note?.key ||
    !change.before?.checksum ||
    !change.after?.checksum
  )
    return null;
  return [{ ...change, kind: "note_change", actionId: result.actionId }];
}

/** Failed is not applied: reload native state only to retain a diagnostic before/after pair. */
export async function failedNoteChange(
  error: unknown,
  note: Zotero.Item | null,
  beforeHtml: string,
  conversationKey: number,
): Promise<Record<string, unknown> | null> {
  const actionId = (error as { journalActionId?: unknown })?.journalActionId;
  if (typeof actionId !== "string" || !note?.key) return null;
  try {
    await note.reload(["note"], true);
    const change = await captureNoteChange(note, beforeHtml, conversationKey);
    if (!change) return null;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      error: reason,
      status: "failed",
      actionId,
      noteChange: {
        ...change,
        state: "failed",
        description: `The write failed: ${reason}. Inspect the recorded state before retrying.`,
      },
    };
  } catch {
    return null;
  }
}

export async function presentNoteChangeFailure(
  error: unknown,
  note: Zotero.Item | null,
  beforeHtml: string | undefined,
  conversationKey: number,
): Promise<never> {
  const content =
    beforeHtml === undefined
      ? null
      : await failedNoteChange(error, note, beforeHtml, conversationKey);
  throw content ? new ToolExecutionFailure(error, content) : error;
}
