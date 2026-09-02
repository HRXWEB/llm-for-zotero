import { assert } from "chai";
import {
  buildAgentInitialMessages,
  composeAgentModelInput,
  renderAgentPromptEnvelope,
} from "../src/agent/model/messageBuilder";
import type { PlanExecutionLedger } from "../src/agent/plans/types";
import type { AgentModelMessage } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("agent prompt envelope", function () {
  it("keeps host-owned execution identities out of the final answer", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-secret",
      planId: "plan-secret",
      revision: 1,
      planDigest: "sha256:secret",
      conversationKey: 703,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-secret",
        revision: 1,
        planDigest: "sha256:secret",
        conversationKey: 703,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 703,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: { planExecutionLedger: ledger },
    });

    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(
      prompt,
      "Your final answer should answer the original request naturally",
    );
    assert.include(prompt, "Do not expose plan IDs");
    assert.include(prompt, "the host renders progress separately");
  });

  it("exposes the exact approved document contract during execution", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-document",
      planId: "plan-document",
      revision: 1,
      planDigest: "sha256:document",
      conversationKey: 704,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-document",
        revision: 1,
        planDigest: "sha256:document",
        conversationKey: 704,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 704,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: {
        planExecutionLedger: ledger,
        approvedPlanContract: {
          deliverable: {
            kind: "document",
            spec: {
              kind: "literature_review",
              title: "Exact approved review title",
              requiredSections: ["Findings", "Scope and limitations"],
              requiresReferences: true,
              requiresCoverageSection: true,
              allowFigures: false,
              citationStyle: {
                styleId: "apa",
                styleTitle: "APA",
                locale: "en-US",
              },
            },
          },
        },
      },
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Exact title: Exact approved review title");
    assert.include(
      prompt,
      "Required sections: Findings; Scope and limitations",
    );
    assert.include(prompt, "submit_plan_document.title must match");
  });

  it("distinguishes omitted transcript history from an explicit empty override", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 701,
      mode: "agent",
      userText: "Current request",
      model: "test-model",
      history: [
        { role: "user", content: "Prior user message" },
        { role: "assistant", content: "Prior assistant message" },
      ],
    });

    const derivedHistory = await buildAgentInitialMessages(request, [], []);
    const noHistory = await buildAgentInitialMessages(
      request,
      [],
      [],
      undefined,
      { transcriptMessages: [] },
    );

    assert.include(JSON.stringify(derivedHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior assistant message");
    assert.include(JSON.stringify(noHistory), "Current request");
  });

  it("freezes the rendered turn and composes fresh ordered message values", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 702,
      mode: "agent",
      userText: "Inspect the supplied image",
      model: "test-model",
      systemPrompt: "SYSTEM_SENTINEL",
      customInstructions: "CUSTOM_SENTINEL",
      screenshots: ["data:image/png;base64,ZmFrZQ=="],
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      [],
      [],
      undefined,
      {
        contentInputs: {
          images: true,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const transcript: AgentModelMessage[] = [
      { role: "assistant", content: "Prior answer" },
    ];
    const checkpoint: AgentModelMessage = {
      role: "user",
      content: "Agent semantic continuation checkpoint: continue safely.",
    };

    const first = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });
    request.systemPrompt = "CHANGED_SYSTEM";
    request.customInstructions = "CHANGED_CUSTOM";
    request.userText = "Changed request";
    request.screenshots![0] = "data:image/png;base64,Y2hhbmdlZA==";
    const second = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });

    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    for (let index = 0; index < first.length; index += 1) {
      assert.notStrictEqual(second[index], first[index]);
    }
    const turnIndex = first.length - 2;
    assert.equal(first[turnIndex - 1].role, "assistant");
    assert.equal(first[turnIndex].role, "user");
    assert.equal(first.at(-1)?.role, "user");
    assert.include(messageText(first[0]), "SYSTEM_SENTINEL");
    assert.include(messageText(first[0]), "CUSTOM_SENTINEL");
    assert.include(messageText(first[turnIndex]), "Inspect the supplied image");
    assert.equal(
      typeof first[turnIndex].content === "string"
        ? ""
        : first[turnIndex].content.find((part) => part.type === "image_url")
            ?.type,
      "image_url",
    );
    assert.include(
      messageText(first.at(-1)!),
      "Agent semantic continuation checkpoint",
    );

    if (typeof first[turnIndex].content !== "string") {
      const textPart = first[turnIndex].content.find(
        (part) => part.type === "text",
      );
      if (textPart?.type === "text") textPart.text = "Mutated composed copy";
    }
    const third = composeAgentModelInput(rendered.envelope);
    assert.include(messageText(third.at(-1)!), "Inspect the supplied image");
    assert.notInclude(messageText(third.at(-1)!), "Mutated composed copy");
  });
});
