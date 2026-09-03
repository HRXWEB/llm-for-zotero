import { assert } from "chai";
import {
  authorizeOriginalAction,
  normalizeStoredActionConstraints,
  parseActionConstraints,
} from "../src/agent/authorization/policy";
import {
  ambiguousInvocationPlan,
  prohibitedInvocationPlan,
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import type {
  ActionProposal,
  OriginalAuthorizationContext,
} from "../src/agent/authorization/types";
import type {
  AgentActionProposal,
  AgentInvocationPlan,
  AgentToolDefinition,
} from "../src/agent/types";

function tool(
  name: string,
  executionClass: "read" | "external_effect" = "external_effect",
) {
  return {
    spec: {
      name,
      description: name,
      inputSchema: { type: "object" },
      executionClass,
      requiresConfirmation: false,
    },
    validate: (input: unknown) => ({ ok: true as const, value: input }),
    planInvocation: () =>
      readOnlyInvocationPlan({ reason: "Test tool invocation." }),
    execute: async () => ({ content: {}, effect: "none" as const }),
  } satisfies AgentToolDefinition<unknown, unknown>;
}

function proposal(
  name: string,
  input: unknown,
  plan: AgentInvocationPlan,
  typedProposals?: AgentActionProposal[],
) {
  return buildActionProposal({
    tool: tool(name, plan.impact === "read_only" ? "read" : "external_effect"),
    input,
    plan,
    typedProposals,
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

const zoteroRead = () =>
  readOnlyInvocationPlan({
    domains: ["zotero_library"],
    reason: "The host-owned reader cannot mutate Zotero.",
  });

const fileWrite = (riskSignals: AgentInvocationPlan["riskSignals"] = []) =>
  stateChangeInvocationPlan({
    domains: ["filesystem"],
    effects: ["modify"],
    targets: ["/tmp/result.md"],
    riskSignals,
    reversibility: "full",
    reason: "The host will replace the named file and retain its pre-image.",
  });

const shellRead = () =>
  readOnlyInvocationPlan({
    mechanism: "shell",
    assurance: "statically_recognized",
    domains: ["local_execution", "filesystem"],
    reason: "Every stage is in the audited read-only grammar.",
  });

describe("Original Agent unified authorization", function () {
  it("binds the complete invocation plan and every input to the digest", function () {
    const input = {
      action: "write",
      filePath: "/tmp/a.md",
      content: "alpha",
    };
    const basePlan = stateChangeInvocationPlan({
      domains: ["filesystem"],
      effects: ["modify"],
      targets: ["/tmp/a.md"],
      reversibility: "partial",
      reason: "Replace the requested file.",
    });
    const base = proposal("file_io", input, basePlan);
    for (const changed of [
      { action: "write", filePath: "/tmp/b.md", content: "alpha" },
      { action: "write", filePath: "/tmp/a.md", content: "beta" },
    ]) {
      assert.notEqual(
        proposal("file_io", changed, basePlan).payloadDigest,
        base.payloadDigest,
      );
    }
    assert.notEqual(
      proposal("file_io", input, {
        ...basePlan,
        targets: ["/tmp/b.md"],
      }).payloadDigest,
      base.payloadDigest,
    );
    const rebound = buildActionProposal({
      tool: tool("file_io"),
      input,
      plan: basePlan,
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

  it("copies safety only from the invocation plan, never from the tool name or descriptor", function () {
    const plan = readOnlyInvocationPlan({
      mechanism: "none",
      domains: ["zotero_library"],
      effects: ["read"],
      targets: ["item:7"],
      reversibility: "full",
      reason: "A deliberately read-only fixture.",
    });
    const action = proposal("run_command", { command: "opaque" }, plan, [
      {
        id: "descriptor:write-shaped-name",
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        source: "zotero_native",
        requestedTargets: ["setting:anything"],
        destinationCollectionIds: [],
      },
    ]);

    assert.deepEqual(action.invocationPlan, plan);
    assert.deepEqual(action.domains, plan.domains);
    assert.deepEqual(action.effects, plan.effects);
    assert.deepEqual(action.targets, plan.targets);
    assert.deepEqual(action.riskSignals, plan.riskSignals);
    assert.deepEqual(action.capabilities, ["zotero.settings"]);
    assert.equal(action.operation, "settings_update");
  });

  it("applies the Safe, Auto, and YOLO policy matrix", function () {
    const cases: Array<{
      name: string;
      action: ActionProposal;
      userText: string;
      safe: string;
      auto: string;
      yolo: string;
    }> = [
      {
        name: "runtime-enforced read",
        action: proposal("library_search", { query: "paper" }, zoteroRead()),
        userText: "Find this paper in my library.",
        safe: "execute",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "recognized shell read",
        action: proposal("run_command", { command: "git diff" }, shellRead()),
        userText: "Show the diff.",
        safe: "execute",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "requested state change",
        action: proposal("file_io", { action: "write" }, fileWrite()),
        userText: "Write the result to /tmp/result.md.",
        safe: "confirm",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "unrelated state change",
        action: proposal("file_io", { action: "write" }, fileWrite()),
        userText: "Explain the result.",
        safe: "confirm",
        auto: "confirm",
        yolo: "execute",
      },
      {
        name: "ambiguous arbitrary code",
        action: proposal(
          "run_command",
          { command: "python3 analyze.py" },
          ambiguousInvocationPlan({
            mechanism: "shell",
            reason: "The interpreter is outside the audited grammar.",
          }),
        ),
        userText: "Explain the result.",
        safe: "confirm",
        auto: "execute",
        yolo: "execute",
      },
      {
        name: "exceptional danger",
        action: proposal(
          "run_command",
          { command: "rm -rf /tmp/results" },
          fileWrite(["broad_delete"]),
        ),
        userText: "Delete the project output directory.",
        safe: "confirm",
        auto: "confirm",
        yolo: "execute",
      },
      {
        name: "enforced hard boundary",
        action: proposal(
          "run_command",
          { command: "rm -rf /" },
          prohibitedInvocationPlan({
            mechanism: "shell",
            domains: ["local_execution", "filesystem"],
            riskSignals: ["protected_target"],
            reason: "The command targets a protected root.",
          }),
        ),
        userText: "Delete everything.",
        safe: "block",
        auto: "block",
        yolo: "block",
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

  it("separates state-change constraints from mechanism constraints", function () {
    const readCommand = proposal(
      "run_command",
      { command: "rg term src" },
      shellRead(),
    );
    assert.equal(
      decide(readCommand, {
        userText: "Do not change anything; inspect the source.",
        constraints: parseActionConstraints(
          "Do not change anything; inspect the source.",
        ),
      }).kind,
      "execute",
    );
    assert.equal(
      decide(readCommand, {
        userText: "Do not run commands or scripts.",
        constraints: parseActionConstraints("Do not run commands or scripts."),
      }).kind,
      "block",
    );

    const webResearch = proposal(
      "web_search",
      { query: "recent papers" },
      readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        reason: "The provider receives a public search query.",
      }),
    );
    assert.equal(
      decide(webResearch, {
        userText: "Do not modify my library; look up recent papers.",
        constraints: parseActionConstraints(
          "Do not modify my library; look up recent papers.",
        ),
      }).kind,
      "execute",
    );
    assert.equal(
      decide(webResearch, {
        userText: "No network requests.",
        constraints: parseActionConstraints("No network requests."),
      }).kind,
      "block",
    );
  });

  it("normalizes legacy execute effects into mechanism constraints", function () {
    assert.deepEqual(
      normalizeStoredActionConstraints([
        {
          kind: "deny_effects",
          effects: ["execute", "modify"],
          domains: ["local_execution"],
          description: "Legacy execution fence.",
        },
      ]),
      [
        {
          kind: "deny_effects",
          effects: ["modify"],
          domains: ["local_execution"],
          description: "Legacy execution fence.",
        },
        {
          kind: "deny_mechanisms",
          mechanisms: ["shell", "zotero_script"],
          description: "Legacy execution fence.",
        },
      ],
    );
  });
});
