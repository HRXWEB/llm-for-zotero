import { assert } from "chai";
import { inferActionIntentsFromRequest } from "../src/agent/model/actionIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("active note editing intent", function () {
  for (const text of [
    "help me rewrite this sentence",
    "Please shorten this paragraph",
    "Can you polish the selected text?",
    "请帮我润色这句话",
  ]) {
    it(`requires a note patch proposal for ${text}`, function () {
      const request = resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: text,
        activeNoteContext: {
          noteId: 3975,
          title: "Note",
          noteKind: "standalone",
          noteText: "Selected sentence.",
        },
        selectedTexts: ["Selected sentence."],
        selectedTextSources: ["note-edit"],
      });
      const intents = inferActionIntentsFromRequest(request);
      assert.lengthOf(intents, 1);
      assert.equal(intents[0].operation, "note_edit");
      assert.equal(intents[0].parameters?.targetNoteId, 3975);
    });
  }
  for (const text of [
    "What does this sentence mean?",
    "Do not edit this note. Explain the sentence.",
    "How would you rewrite a paragraph?",
    "Give me three alternatives without changing the note.",
  ]) {
    it(`leaves explanatory requests in chat: ${text}`, function () {
      const request = resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: text,
        activeNoteContext: {
          noteId: 3975,
          title: "Note",
          noteKind: "standalone",
          noteText: "Selected sentence.",
        },
      });
      assert.isEmpty(inferActionIntentsFromRequest(request));
    });
  }
  for (const text of [
    "Edit note 60 to fix the typo",
    "Edit the paper metadata",
  ]) {
    it(`does not redirect another target to the active note: ${text}`, function () {
      const intents = inferActionIntentsFromRequest(
        resolvedAgentRequest({
          conversationKey: 1,
          mode: "agent",
          userText: text,
          activeNoteContext: {
            noteId: 3975,
            title: "Note",
            noteKind: "standalone",
            noteText: "Text.",
          },
        }),
      );
      assert.isFalse(
        intents.some((intent) => intent.parameters?.targetNoteId === 3975),
      );
      if (text.includes("60"))
        assert.equal(intents[0].parameters?.targetNoteId, 60);
    });
  }
});
