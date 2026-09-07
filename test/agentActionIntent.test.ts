import { assert } from "chai";
import {
  ActionContractService,
  type ActionContractGateway,
} from "../src/agent/contracts/actionContract";
import {
  inferActionIntentsFromRequest,
  parseClassifiedTurnIntent,
} from "../src/agent/model/skillClassifier";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifyWriteNoteDestination } from "../src/agent/writeNoteDestination";
import { reconcileNoteDestinationActionIntents } from "../src/agent/model/actionIntent";

function request(
  input: Partial<AgentRuntimeRequestInput>,
): ReturnType<typeof resolvedAgentRequest> {
  return resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText: "",
    ...input,
  });
}

describe("Agent action intent", function () {
  it("binds a numeric item list before preservation language can imply library-wide coverage", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          'Add the tag "codex-native-plan-20260906" to exactly Zotero items 3900, 3920, and 3930 in library 1. Preserve all existing tags, notes, attachments, and collection memberships. Do not modify any other items.',
      }),
    );
    assert.lengthOf(intents, 1);
    assert.deepEqual(
      intents[0].targetSelectors,
      [3900, 3920, 3930].map((value) => ({ kind: "item_id", value })),
    );
    assert.equal(intents[0].coverage, "some");
    assert.deepEqual(intents[0].parameters, {
      tags: ["codex-native-plan-20260906"],
    });
  });
  it("does not turn a prohibition on other fields into a requested metadata edit", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          "Set exactly these three tags on only the papers with item keys WTI4KW3E, MG2MBGKQ, and N2TKK3CR in My Library: coding-GOAL-20260905, drift-GOAL-20260905, memory-GOAL-20260905. Replace their previous tags with this exact set; do not change any other item or field.",
      }),
    );
    assert.deepEqual(
      intents.map((intent) => intent.operation),
      ["set_item_tags"],
    );
  });
  it("does not confuse quoted paper titles with tag values or expand each named paper to the library", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          'Apply exactly these three tags to each of the papers titled "Geometry of population coding 05a2342c", "Memory and representational drift 05a2342c", "Geometry and memory shared paper 05a2342c": coding-GOAL-20260905, drift-GOAL-20260905, memory-GOAL-20260905. Replace their old tags with this exact set. Do not tag any other paper.',
      }),
    );
    assert.lengthOf(intents, 1);
    assert.equal(intents[0].operation, "set_item_tags");
    assert.equal(intents[0].coverage, "some");
    assert.lengthOf(intents[0].targetSelectors!, 3);
    assert.notInclude(
      JSON.stringify(intents[0].parameters || {}),
      "population coding",
    );
  });
  it("binds an affirmative existing-note replacement, not the prohibited creation", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          "Replace the content of existing note 3961 with this exact HTML: <h1>HTML review probe</h1><p>A <strong>formatted</strong> result.</p>. Do not create a new note.",
      }),
    );
    assert.deepEqual(
      intents.map((intent) => intent.operation),
      ["note_edit"],
    );
    assert.equal(intents[0].parameters?.targetNoteId, 3961);
    assert.equal(intents[0].coverage, "one");
  });

  it("treats the described historical edit as the undo target, not a fresh write", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          "Undo the last note edit in this conversation. Restore note 3932 exactly from its saved pre-edit journal content.",
      }),
    );
    assert.deepEqual(
      intents.map((intent) => intent.operation),
      ["undo"],
    );
  });

  it("binds a target-first exact note edit instead of treating it as a read", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          'In note 3932, replace only the first occurrence of the exact text "copper-limitation" with "copper-limitation (reviewed)". Preserve every other character and section.',
      }),
    );
    assert.lengthOf(intents, 1);
    assert.equal(intents[0].operation, "note_edit");
    assert.equal(intents[0].parameters?.targetNoteId, 3932);
    assert.equal(intents[0].coverage, "one");
  });

  it("distinguishes a standalone note destination from a source collection", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          'Create exactly one standalone version of note 3932 and file it in the collection named "notes 05a2342c" (collection 79, library 1). Preserve its complete content and all six sections.',
      }),
    );
    assert.lengthOf(intents, 1);
    assert.equal(intents[0].operation, "note_create");
    assert.equal(intents[0].scopeRole, "destination");
    assert.equal(intents[0].scope?.path, "notes 05a2342c");
    assert.equal(intents[0].coverage, "one");
  });

  it("keeps the requested trash action when permanent deletion is prohibited", function () {
    const intents = inferActionIntentsFromRequest(
      request({
        userText:
          "Move to trash (do not permanently delete) only the paper with item key JBU4RMQ9.",
      }),
    );
    assert.deepEqual(
      intents.map((intent) => intent.operation),
      ["trash_items"],
    );
  });

  it("keeps file export independent of a prohibition on Zotero edits", function () {
    for (const userText of [
      'Read saved note 3932 and export its complete content as Markdown to "/tmp/behavior-vault/conversation.md". Preserve all six sections; save the actual file.',
      'Write a short summary of this paper including one actual cropped figure. Use the figure-analysis pipeline, save the Markdown to "/tmp/behavior-vault/figures.md" and copy the cropped figure into that vault using a relative image link. Include a caption and page provenance. Do not edit Zotero or substitute a placeholder.',
    ]) {
      const intents = reconcileNoteDestinationActionIntents(
        inferActionIntentsFromRequest(request({ userText })),
        classifyWriteNoteDestination(userText),
      );
      assert.deepEqual(
        intents.map((intent) => intent.operation),
        ["file_write"],
      );
      assert.match(
        intents[0].parameters?.filePath || "",
        /^\/tmp\/behavior-vault\//,
      );
    }
  });
  it("fails closed when required intent has no valid obligations", async function () {
    const service = new ActionContractService({} as ActionContractGateway);
    let message = "";
    try {
      await service.createContract(
        request({
          conversationKey: 1,
          mode: "agent",
          model: "test",
          userText: "Apply the requested mutation.",
          classifiedIntent: {
            retrievalIntent: "none",
            wantedSections: [],
            writeDisposition: "required",
            actionInterpretationSource: "classifier",
            actionIntents: [],
          },
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "no valid typed obligations");
  });

  it("does not infer writes from questions, advice, hypotheticals, or negation", function () {
    const prompts = [
      "Which papers should I tag as reviewed?",
      "If I add the tag reviewed, which papers would be candidates?",
      "Please do not add or remove any tags; only explain the options.",
      "How could I tag these papers later?",
    ];
    for (const userText of prompts) {
      assert.deepEqual(
        inferActionIntentsFromRequest(request({ userText })),
        [],
      );
    }
  });

  it("uses a successful classifier as the exact authoritative operation", function () {
    const parsed = parseClassifiedTurnIntent(
      JSON.stringify({
        retrievalIntent: "none",
        wantedSections: [],
        writeDisposition: "required",
        actionIntents: [
          {
            operation: "remove_tags",
            coverage: "all",
            targetKind: "papers",
            parameters: { tags: ["reviewed"] },
          },
        ],
      }),
    );
    assert.equal(parsed?.writeDisposition, "required");
    assert.deepEqual(
      parsed?.actionIntents.map((intent) => intent.operation),
      ["remove_tags"],
    );
  });

  it("infers only high-confidence imperative operations on classifier failure", function () {
    const add = inferActionIntentsFromRequest(
      request({
        userText: 'Add the tag "topic:drift" to every paper.',
      }),
    );
    assert.equal(add[0]?.operation, "apply_tags");
    assert.deepEqual(add[0]?.parameters?.tags, ["topic:drift"]);

    const create = inferActionIntentsFromRequest(
      request({
        userText: 'Create collection "Methods".',
      }),
    );
    assert.equal(create[0]?.operation, "create_collection");
    assert.equal(create[0]?.parameters?.collectionName, "Methods");

    const mixed = inferActionIntentsFromRequest(
      request({
        userText:
          'Create a standalone Zotero note and independently export a Markdown file at "/tmp/acv2-vault/ACV2 Mixed.md".',
      }),
    );
    assert.deepEqual(
      mixed.map((intent) => intent.operation),
      ["note_create", "file_write"],
    );
    assert.equal(
      mixed.find((intent) => intent.operation === "file_write")?.parameters
        ?.filePath,
      "/tmp/acv2-vault/ACV2 Mixed.md",
    );
  });

  it("keeps note intent available when multilingual classification degrades", function () {
    const prompts = [
      "请创建一条 Zotero 笔记。",
      "Zoteroノートを作成してください。",
      "Crea una nota de Zotero.",
    ];

    for (const userText of prompts) {
      assert.deepEqual(
        inferActionIntentsFromRequest(request({ userText })).map(
          (intent) => intent.operation,
        ),
        ["note_create"],
        userText,
      );
    }
  });
});
