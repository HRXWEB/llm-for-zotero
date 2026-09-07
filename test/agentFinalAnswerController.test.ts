import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import type { AgentFinalActionSession } from "../src/agent/finalization/finalAnswerController";
import type { AgentRuntimeRequest } from "../src/agent/types";

function makeRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 1,
    mode: "agent",
    userText: "Answer the question",
    model: "test-model",
    turnPaperScope: {
      active: [],
      added: [],
      pinned: [],
      selected: [],
      collections: [],
      tags: [],
    },
    ...overrides,
  } as AgentRuntimeRequest;
}

function acceptingActionSession(): AgentFinalActionSession {
  return {
    evaluateFinal: async () => ({ kind: "accept" as const }),
  };
}

describe("AgentFinalAnswerController", function () {
  it("requires one source check before publishing an evidence-based paper answer", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        conversationKind: "paper",
        userText: "Explain the reported decoding comparison.",
        classifiedIntent: {
          semantic: semanticFixture(),
          // Single-paper reads deliberately use none: this field controls
          // collection/library retrieval, not whether an answer needs evidence.
          retrievalIntent: "none",
          wantedSections: ["results"],
          actionIntents: [],
        },
      }),
      acceptingActionSession(),
      [],
    );
    const records = [
      {
        name: "paper_read",
        ok: true,
        content: {
          results: [
            { text: "Intact accuracy is 0.80; shuffled accuracy is 0.52." },
          ],
        },
      },
    ];
    const first = await controller.evaluate({
      candidateText: "Shuffled accuracy is near chance for a binary task.",
      canCorrect: true,
      toolExecutionRecords: records,
    });
    assert.equal(first.kind, "correct");
    if (first.kind !== "correct") return;
    assert.include(first.correction, "source-check");
    assert.include(first.correction, "unsupported");
    assert.include(first.correction, "do not create");
    const second = await controller.evaluate({
      candidateText:
        "The source gives no class count or chance baseline. Intact accuracy is 0.80 and shuffled accuracy is 0.52.",
      canCorrect: true,
      toolExecutionRecords: records,
    });
    assert.equal(
      second.kind,
      "accept",
      "one review, not an endless self-review loop",
    );
  });

  it("does not require a paper source-check for a write receipt or a finalized document", async function () {
    for (const overrides of [
      { actionContract: { obligations: [{ operation: "note_create" }] } },
      { documentOutcomePolicy: { required: true } },
    ]) {
      const controller = new AgentFinalAnswerController(
        makeRequest({ conversationKind: "paper", ...overrides } as never),
        acceptingActionSession(),
        [],
      );
      const result = await controller.evaluate({
        candidateText: "Saved.",
        canCorrect: true,
        toolExecutionRecords: [
          { name: "paper_read", ok: true },
          { name: "submit_document", ok: true },
        ],
      });
      assert.equal(result.kind, "accept");
    }
  });

  it("lets Plan correction policy observe successful tool progress", async function () {
    const observedCounts: number[] = [];
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      acceptingActionSession(),
      [],
      {
        evaluateFinal: async (params) => {
          observedCounts.push(params.successfulToolResultCount || 0);
          return { kind: "accept" as const };
        },
      } as never,
    );

    await controller.evaluate({
      candidateText: "Done.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "research_update", ok: true },
        { name: "research_update", ok: false },
        { name: "task_update", ok: true },
      ],
    });

    assert.deepEqual(observedCounts, [2]);
  });

  it("allows one required-document correction and then fails closed", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        documentOutcomePolicy: {
          required: true,
          documentKind: "report",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      }),
      acceptingActionSession(),
      [],
    );

    const first = await controller.evaluate({
      candidateText: "A long prose answer that bypassed the artifact.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      assert.include(first.correction, "call submit_document now");
    }

    const second = await controller.evaluate({
      candidateText: "Another prose answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.deepEqual(second, {
      kind: "fail",
      userMessage:
        "The requested document was not finalized, so ordinary answer text cannot be accepted as the completed outcome.",
    });
  });

  it("accepts a required document only after submit_document succeeds", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        documentOutcomePolicy: {
          required: true,
          documentKind: "guide",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      }),
      acceptingActionSession(),
      [],
    );
    const decision = await controller.evaluate({
      candidateText: "# Complete guide",
      canCorrect: false,
      toolExecutionRecords: [
        { name: "submit_document", ok: true, content: { documentId: "d1" } },
      ],
    });
    assert.equal(decision.kind, "accept");
  });

  it("accepts the persisted legacy submit_plan_document alias", async function () {
    const request = makeRequest({
      documentOutcomePolicy: {
        required: true,
        documentKind: "report",
        integrityPolicy: "authored",
        trigger: "plan_deliverable",
      },
    });
    const controller = new AgentFinalAnswerController(
      request,
      acceptingActionSession(),
      [],
    );
    const decision = await controller.evaluate({
      candidateText: "Document body",
      canCorrect: true,
      toolExecutionRecords: [
        {
          name: "submit_plan_document",
          ok: true,
          content: { documentId: "legacy-d1" },
        },
      ],
    });
    assert.equal(decision.kind, "accept");
  });

  it("returns an uncommitted action-contract correction before other quality gates", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      {
        evaluateFinal: async () => ({
          kind: "correct" as const,
          correction: "Complete the required action.",
        }),
      },
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Draft",
      canCorrect: true,
      toolExecutionRecords: [],
    });

    assert.deepEqual(decision, {
      kind: "correct",
      correction: "Complete the required action.",
      actionContractRejection: {
        kind: "correct",
        correction: "Complete the required action.",
      },
    });
  });

  it("returns a kind-matched uncommitted action-contract failure", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      {
        evaluateFinal: async () => ({
          kind: "fail" as const,
          failure: "The action could not be verified.",
        }),
      },
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Draft",
      canCorrect: false,
      toolExecutionRecords: [],
    });

    assert.deepEqual(decision, {
      kind: "fail",
      userMessage: "The action could not be verified.",
      actionContractRejection: {
        kind: "fail",
        failure: "The action could not be verified.",
      },
    });
  });

  it("allows one collection evidence correction then accepts the next final", async function () {
    const request = makeRequest({
      userText: "What methods do these papers share?",
      classifiedIntent: {
        semantic: semanticFixture(),
        retrievalIntent: "summarize",
        wantedSections: ["methods"],
        actionIntents: [],
      },
      turnPaperScope: {
        active: [],
        added: [],
        pinned: [],
        selected: [],
        collections: [{ collectionId: 3, name: "C", libraryID: 1 }],
        tags: [],
      },
    });
    const controller = new AgentFinalAnswerController(
      request,
      acceptingActionSession(),
      [],
    );

    const first = await controller.evaluate({
      candidateText: "Shallow answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      assert.notProperty(first, "actionContractRejection");
    }

    const second = await controller.evaluate({
      candidateText: "Disclosed partial answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(second.kind, "accept");
  });

  it("returns a clean assistant copy for a web-attribution correction", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      acceptingActionSession(),
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "An unsupported current claim.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "web_search", ok: true, content: { results: [] } },
      ],
    });

    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.notProperty(decision, "actionContractRejection");
    assert.equal(decision.assistantContent, "An unsupported current claim.");
    assert.include(decision.correction, "Correct the web attribution");
  });
});
