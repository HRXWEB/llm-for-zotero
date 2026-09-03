import { assert } from "chai";
import { createRequestUserInputTool } from "../src/agent/tools/plan/requestUserInput";
import type { AgentToolContext } from "../src/agent/types";

const context = {} as AgentToolContext;

describe("request_user_input planning card contract", function () {
  it("keeps descriptions structured and enables custom answers", async function () {
    const tool = createRequestUserInputTool();
    const validated = tool.validate({
      questions: [
        {
          id: "scope",
          question: "Which corpus should the review use?",
          options: [
            {
              id: "collection",
              label: "Selected collection",
              description: "Use the current collection only.",
            },
            { id: "library", label: "Whole library" },
          ],
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = await tool.createPendingAction!(validated.value, context);
    assert.equal(pending.fields[0].type, "choice");
    if (pending.fields[0].type !== "choice") return;
    assert.equal(pending.fields[0].options[0].label, "Selected collection");
    assert.equal(
      pending.fields[0].options[0].description,
      "Use the current collection only.",
    );
    assert.isTrue(pending.fields[0].allowCustom);
    assert.equal(pending.fields[0].customPlaceholder, "Something else…");
  });

  it("normalizes declared and custom selections into the existing answer shape", async function () {
    const tool = createRequestUserInputTool();
    const validated = tool.validate({
      questions: [
        {
          id: "scope",
          question: "Which corpus?",
          options: [
            { id: "collection", label: "Collection" },
            { id: "library", label: "Library" },
          ],
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const optionInput = tool.applyConfirmation!(
      validated.value,
      { scope: { kind: "option", optionId: "library" } },
      context,
    );
    assert.isTrue(optionInput.ok);
    if (optionInput.ok) {
      assert.deepEqual(await tool.execute(optionInput.value, context), {
        answers: [{ id: "scope", answer: "library" }],
      });
    }

    const customInput = tool.applyConfirmation!(
      validated.value,
      { scope: { kind: "custom", text: "  My reading list  " } },
      context,
    );
    assert.isTrue(customInput.ok);
    if (customInput.ok) {
      assert.deepEqual(await tool.execute(customInput.value, context), {
        answers: [{ id: "scope", answer: "My reading list" }],
      });
    }
  });
});
