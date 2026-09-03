import { assert } from "chai";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { resolveDocumentOutcomePolicy } from "../src/agent/documents/outcomePolicy";

function request(userText: string, extra: Record<string, unknown> = {}) {
  return resolveAgentRuntimeRequest({
    conversationKey: 41,
    mode: "agent",
    userText,
    libraryID: 1,
    ...extra,
  });
}

describe("DocumentOutcomePolicy", function () {
  it("requires research-grounded documents for planned literature reviews", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("continue", {
        planContext: {
          phase: "executing",
          planId: "plan-1",
          revision: 1,
          executionId: "execution-1",
          approvedDigest: "sha256:approved",
          provider: "original",
        },
      }),
      matchedSkillIds: ["literature-review"],
      plannedDocumentKind: "literature_review",
      plannedResearch: true,
    });
    assert.deepInclude(policy, {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "plan_deliverable",
    });
  });

  it("does not invent a document for a non-writing plan outcome", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("continue", {
        planContext: {
          phase: "executing",
          planId: "plan-2",
          revision: 1,
          executionId: "execution-2",
          approvedDigest: "sha256:approved",
          provider: "original",
        },
      }),
      matchedSkillIds: ["literature-review"],
    });
    assert.isFalse(policy.required);
  });

  it("requires strict validation for explicit or routed literature reviews", function () {
    for (const [text, skills] of [
      ["Review this topic", ["literature-review"]],
      ["Write a literature review about representational drift", []],
    ] as const) {
      const policy = resolveDocumentOutcomePolicy({
        request: request(text),
        matchedSkillIds: skills,
      });
      assert.isTrue(policy.required);
      assert.equal(policy.documentKind, "literature_review");
      assert.equal(policy.integrityPolicy, "research_grounded");
    }
  });

  it("uses lighter authored validation for explicit document writing", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("Please prepare a guide for our lab workflow"),
      matchedSkillIds: [],
    });
    assert.deepInclude(policy, {
      required: true,
      documentKind: "guide",
      integrityPolicy: "authored",
      trigger: "document_intent",
    });
  });

  it("does not confuse discussion of literature reviews with a review deliverable", function () {
    for (const text of [
      "What makes a literature review rigorous?",
      "How should I write a report?",
      "Give me advice on writing a manuscript",
      "Do not write a report; explain the tradeoffs briefly",
    ]) {
      const policy = resolveDocumentOutcomePolicy({
        request: request(text),
        matchedSkillIds: [],
      });
      assert.isFalse(policy.required, text);
    }
  });

  it("keeps a directly requested research brief on authored validation", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("Write a research brief about this topic"),
      matchedSkillIds: [],
    });

    assert.isTrue(policy.required);
    assert.equal(policy.documentKind, "research_brief");
    assert.equal(policy.integrityPolicy, "authored");
  });

  it("uses classifier document intent without a response-length threshold", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("Create the requested deliverable", {
        classifiedIntent: {
          retrievalIntent: "none",
          deliverableIntent: "document",
          documentKind: "report",
          wantedSections: [],
          actionIntents: [],
        },
      }),
      matchedSkillIds: [],
    });
    assert.equal(policy.documentKind, "report");
    assert.equal(policy.integrityPolicy, "authored");
    assert.isFalse(
      resolveDocumentOutcomePolicy({
        request: request("Explain this briefly. ".repeat(500)),
        matchedSkillIds: [],
      }).required,
    );
  });

  it("never requires the final document while a plan is awaiting approval", function () {
    const policy = resolveDocumentOutcomePolicy({
      request: request("Write a literature review", {
        planContext: {
          phase: "planning",
          planId: "plan-3",
          revision: 1,
          provider: "original",
        },
      }),
      matchedSkillIds: ["literature-review"],
    });
    assert.isFalse(policy.required);
  });
});
