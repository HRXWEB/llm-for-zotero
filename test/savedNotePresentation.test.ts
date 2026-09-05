import { assert } from "chai";
import { savedNoteIsPrimaryOutcome } from "../src/modules/contextPanel/agentTrace/savedNoteCard";

describe("saved note primary outcome", function () {
  it("replaces a duplicate document for note-only turns, but preserves explicit documents and plans", function () {
    assert.isTrue(
      savedNoteIsPrimaryOutcome("Create a child note on this paper", false),
    );
    assert.isTrue(
      savedNoteIsPrimaryOutcome(
        "Write a summary note about this article",
        false,
      ),
    );
    assert.isFalse(
      savedNoteIsPrimaryOutcome("Create a note on this paper", true),
    );
    assert.isFalse(
      savedNoteIsPrimaryOutcome("Write a report and save it as a note", false),
    );
    assert.isFalse(
      savedNoteIsPrimaryOutcome(
        "Create a note on this paper and write a separate report",
        false,
      ),
    );
    assert.isFalse(savedNoteIsPrimaryOutcome("", false));
  });
});
