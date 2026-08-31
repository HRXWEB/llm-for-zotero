import { assert } from "chai";
import { authorizeOriginalAction } from "../src/agent/authorization/policy";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import type {
  ActionProposal,
  OriginalAuthorizationContext,
} from "../src/agent/authorization/types";
import type { AgentToolDefinition } from "../src/agent/types";

function tool(name: string, mutability: "read" | "write" = "write") {
  return {
    spec: {
      name,
      description: name,
      inputSchema: { type: "object" },
      mutability,
      requiresConfirmation: false,
    },
    validate: (input: unknown) => ({ ok: true as const, value: input }),
    execute: async () => ({ content: {}, effect: "none" as const }),
  } satisfies AgentToolDefinition<unknown, unknown>;
}

function proposal(name: string, input: unknown, effect: "none" | "write") {
  return buildActionProposal({
    tool: tool(name, effect === "none" ? "read" : "write"),
    input,
    plan: {
      effect,
      reversibility: effect === "none" ? "full" : "partial",
    },
  });
}

function decide(
  action: ActionProposal,
  context: Partial<OriginalAuthorizationContext>,
) {
  return authorizeOriginalAction(action, {
    mode: "auto",
    userText: "",
    hasExplicitNoWrite: false,
    ...context,
  });
}

describe("Original Agent unified authorization", function () {
  it("binds every execution-relevant input to the proposal digest", function () {
    const base = proposal(
      "file_io",
      { action: "write", filePath: "/tmp/a.md", content: "alpha" },
      "write",
    );
    for (const changed of [
      { action: "write", filePath: "/tmp/b.md", content: "alpha" },
      { action: "write", filePath: "/tmp/a.md", content: "beta" },
    ]) {
      assert.notEqual(
        proposal("file_io", changed, "write").payloadDigest,
        base.payloadDigest,
      );
    }
    const rebound = buildActionProposal({
      tool: tool("file_io"),
      input: {
        action: "write",
        filePath: "/tmp/a.md",
        content: "alpha",
      },
      plan: { effect: "write", reversibility: "partial" },
      intentBinding: {
        conversationKey: 7,
        conversationGeneration: 2,
        actionContractId: "contract-2",
        userText: "Write alpha.",
      },
    });
    assert.notEqual(rebound.payloadDigest, base.payloadDigest);
    assert.deepInclude(rebound.intentBinding, {
      conversationKey: 7,
      conversationGeneration: 2,
      actionContractId: "contract-2",
    });
  });

  it("applies Safe, Auto, and YOLO consistently across action domains", function () {
    const cases: Array<{
      name: string;
      action: ActionProposal;
      userText: string;
      safe: string;
      auto: string;
      yolo: string;
    }> = [
      {
        name: "trusted Zotero read",
        action: proposal("library_search", { query: "paper" }, "none"),
        userText: "Find this paper in my library.",
        safe: "execute",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "ordinary file write",
        action: proposal(
          "file_io",
          { action: "write", filePath: "/tmp/result.md", content: "done" },
          "write",
        ),
        userText: "Write the result to /tmp/result.md.",
        safe: "confirm",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "ordinary command",
        action: proposal("run_command", { command: "npm test" }, "write"),
        userText: "Run the tests.",
        safe: "confirm",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "explicit web research",
        action: proposal(
          "web_search",
          { query: "current Zotero release" },
          "none",
        ),
        userText: "Research the current Zotero release online.",
        safe: "confirm",
        auto: "execute",
        yolo: "execute",
      },
    ];

    for (const testCase of cases) {
      for (const mode of ["safe", "auto", "yolo"] as const) {
        assert.equal(
          decide(testCase.action, {
            mode,
            userText: testCase.userText,
          }).kind,
          testCase[mode],
          `${testCase.name} in ${mode}`,
        );
      }
    }
  });

  it("keeps hard constraints and exceptional danger above every mode", function () {
    const ordinaryWrite = proposal(
      "file_io",
      { action: "write", filePath: "/tmp/result.md", content: "done" },
      "write",
    );
    for (const mode of ["safe", "auto", "yolo"] as const) {
      assert.equal(
        decide(ordinaryWrite, {
          mode,
          userText: "Do not change anything.",
          hasExplicitNoWrite: true,
        }).kind,
        "block",
      );
    }

    const protectedDelete = proposal(
      "run_command",
      { command: "rm -rf /" },
      "write",
    );
    assert.equal(
      decide(protectedDelete, {
        mode: "yolo",
        userText: "Delete everything.",
      }).kind,
      "block",
    );
  });

  it("uses confirmation for genuine Auto ambiguity and broad destruction", function () {
    assert.equal(
      decide(
        proposal("file_io", { action: "delete", filePath: "/tmp/a" }, "write"),
        { userText: "Clean things up." },
      ).kind,
      "confirm",
    );
    assert.equal(
      decide(
        proposal(
          "run_command",
          { command: "rm -rf /tmp/project-output" },
          "write",
        ),
        { userText: "Delete the project output directory." },
      ).kind,
      "confirm",
    );
  });
});
