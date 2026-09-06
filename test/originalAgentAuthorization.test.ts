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

const noteWrite = () =>
  stateChangeInvocationPlan({
    domains: ["zotero_library"],
    effects: ["create"],
    targets: ["note:new"],
    reversibility: "full",
    reason: "The host will create the requested Zotero note.",
  });

const shellRead = () =>
  readOnlyInvocationPlan({
    mechanism: "shell",
    assurance: "statically_recognized",
    domains: ["local_execution", "filesystem"],
    reason: "Every stage is in the audited read-only grammar.",
  });

describe("Original Agent unified authorization", function () {
  it("keeps compound paper and note creation prohibitions separate from requested collection work", function () {
    const creation = proposal("collection_update", {}, noteWrite());
    const userText =
      'Create collections "geometry" and "memory", adding the exact existing papers. Preserve their metadata. Do not merge them yet and do not create any papers or notes.';
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const context = {
        mode,
        userText,
        constraints: parseActionConstraints(userText),
        hasMatchingActionIntent: true,
      };
      assert.equal(
        decide({ ...creation, operation: "create_collection" }, context).kind,
        mode === "safe" ? "confirm" : "execute",
      );
      for (const operation of [
        "create_items",
        "import_identifiers",
        "import_local_files",
        "note_create",
        "save_note",
        "save_notes_batch",
        "create_collection+note_create",
      ]) {
        assert.equal(
          decide({ ...creation, operation }, context).kind,
          "block",
          operation,
        );
      }
      assert.equal(
        decide(
          {
            ...creation,
            operation: "zotero_script_execute",
            invocationPlan: {
              ...creation.invocationPlan,
              mechanism: "zotero_script",
              assurance: "unknown",
            },
          },
          context,
        ).kind,
        "block",
        "opaque scripts cannot bypass the restricted target types",
      );
      assert.equal(
        decide(
          { ...creation, operation: "create_collection" },
          {
            ...context,
            constraints: parseActionConstraints(
              `${userText} Do not change anything in Zotero.`,
            ),
          },
        ).kind,
        "block",
        "independent blanket prohibitions are preserved",
      );
    }
  });
  it("uses plan approval without bypassing explicit constraints or protected targets in any mode", function () {
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const context = { mode, hasApprovedPlanAuthority: true };
      assert.deepEqual(decide(proposal("file_io", {}, fileWrite()), context), {
        kind: "execute",
        authority: "plan_approval",
      });
      assert.equal(
        decide(
          proposal("file_io", {}, fileWrite(["protected_target"])),
          context,
        ).kind,
        "block",
      );
      assert.equal(
        decide(proposal("file_io", {}, fileWrite()), {
          ...context,
          constraints: parseActionConstraints("Do not write files."),
        }).kind,
        "block",
      );
    }
  });
  it("keeps a no-new-note constraint scoped to creation while permitting an existing-note edit", function () {
    const userText =
      "Replace the content of existing note 3961. Do not create a new note.";
    const edit = proposal(
      "note_write",
      {},
      stateChangeInvocationPlan({
        domains: ["zotero_library"],
        effects: ["modify"],
        reversibility: "full",
        reason: "Edit the exact note.",
      }),
    );
    edit.operation = "note_edit";
    const create = proposal("note_write", {}, noteWrite());
    create.operation = "note_create";
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const context = {
        mode,
        userText,
        constraints: parseActionConstraints(userText),
        hasMatchingActionIntent: true,
      };
      assert.equal(decide(edit, context).kind, "confirm");
      assert.equal(decide(create, context).kind, "block");
      for (const operation of ["save_note", "save_notes_batch"]) {
        assert.equal(
          decide({ ...create, operation }, context).kind,
          "block",
          `the no-new-note constraint also covers native ${operation}`,
        );
      }
      assert.equal(
        decide({ ...create, operation: "note_create+update_metadata" }, context)
          .kind,
        "block",
      );
      assert.equal(
        decide({ ...create, operation: "create_collection" }, context).kind,
        mode === "safe" ? "confirm" : "execute",
        "a no-note-creation clause is not a ban on unrelated native operations",
      );
      const opaque = {
        ...create,
        operation: "run_zotero_script",
        invocationPlan: {
          ...create.invocationPlan,
          mechanism: "zotero_script" as const,
          assurance: "unknown" as const,
        },
      };
      assert.equal(
        decide(opaque, context).kind,
        "block",
        "opaque execution cannot evade the note-creation restriction",
      );
      assert.equal(
        decide(edit, {
          ...context,
          constraints: parseActionConstraints(
            `${userText} Do not change anything in Zotero.`,
          ),
        }).kind,
        "block",
        "an independent global prohibition is retained",
      );
    }
  });

  it("allows requested trash but blocks permanent deletion in every mode", function () {
    const userText =
      "Move to trash (do not permanently delete) only the paper with item key JBU4RMQ9.";
    const action = proposal(
      "library_delete",
      {},
      stateChangeInvocationPlan({
        effects: ["delete"],
        reversibility: "full",
        reason: "Move an exact item to recoverable trash.",
      }),
    );
    action.operation = "trash_items";
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const context = {
        mode,
        userText,
        constraints: parseActionConstraints(userText),
        hasMatchingActionIntent: true,
      };
      assert.equal(
        decide(action, context).kind,
        mode === "safe" ? "confirm" : "execute",
      );
      assert.equal(
        decide({ ...action, operation: "delete_attachment" }, context).kind,
        "block",
      );
      assert.equal(
        decide(
          { ...action, operation: "trash_items+delete_attachment" },
          context,
        ).kind,
        "block",
      );
    }
    assert.equal(
      decide(action, {
        userText: "Do not change the Zotero library.",
        constraints: parseActionConstraints(
          "Do not change the Zotero library.",
        ),
        hasMatchingActionIntent: true,
      }).kind,
      "block",
    );
  });

  it("does not turn conversational remembering into unsolicited persistence", function () {
    const action = proposal("note_write", {}, noteWrite());
    action.operation = "note_create";
    action.capabilities = ["zotero.notes"];
    for (const mode of ["safe", "auto", "yolo"] as const) {
      assert.equal(
        decide(action, {
          mode,
          userText:
            "Read this synthetic test paper. What is its hypothesis? Explain amber-readout and remember it for our discussion.",
        }).kind,
        "block",
      );
      assert.equal(
        decide(action, {
          mode,
          userText:
            "Remember this for our discussion and create a Zotero note.",
          hasMatchingActionIntent: true,
        }).kind,
        "execute",
      );
    }
  });
  it("only exempts a contract-matched native note creation, never edits or extra effects", function () {
    const creation = proposal("note_write", { mode: "create" }, noteWrite(), [
      {
        id: "note:create",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        source: "zotero_native",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ]);
    const context = {
      mode: "safe" as const,
      userText: "Create a note",
      hasMatchingActionIntent: true,
    };
    assert.equal(decide(creation, context).kind, "execute");
    assert.equal(
      decide(creation, { ...context, hasMatchingActionIntent: false }).kind,
      "confirm",
    );
    for (const override of [
      { operation: "note_edit", effects: ["modify"] },
      { operation: "note_append", effects: ["modify"] },
      {
        operation: "note_create+file_write",
        domains: ["zotero_library", "filesystem"],
      },
      { effects: ["create", "delete"] },
      { riskSignals: ["ambiguous_target"] },
    ])
      assert.equal(
        decide({ ...creation, ...override } as ActionProposal, context).kind,
        "confirm",
      );
    assert.equal(
      decide(creation, {
        ...context,
        constraints: parseActionConstraints("Do not create notes."),
      }).kind,
      "block",
    );
  });
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

  it("recognizes clear Auto actions across supported query languages", function () {
    const cases = [
      {
        name: "Simplified Chinese Zotero note",
        action: proposal("write_note", {}, noteWrite()),
        userText: "请在 Zotero 中创建一条笔记。",
      },
      {
        name: "Traditional Chinese file",
        action: proposal("file_io", {}, fileWrite()),
        userText: "請把結果寫入檔案。",
      },
      {
        name: "Japanese file",
        action: proposal("file_io", {}, fileWrite()),
        userText: "この結果をファイルに保存してください。",
      },
      {
        name: "Spanish file",
        action: proposal("file_io", {}, fileWrite()),
        userText: "Guarda el resultado en un archivo.",
      },
    ];

    for (const testCase of cases) {
      assert.deepInclude(
        decide(testCase.action, { userText: testCase.userText }),
        { kind: "execute", authority: "auto_policy" },
        testCase.name,
      );
    }
  });

  it("blocks multilingual explicit prohibitions before any mode can execute", function () {
    const cases = [
      {
        name: "Simplified Chinese command prohibition",
        action: proposal("run_command", {}, shellRead()),
        userText: "不要运行命令。",
      },
      {
        name: "Traditional Chinese Zotero prohibition",
        action: proposal("write_note", {}, noteWrite()),
        userText: "請勿修改 Zotero 資料庫。",
      },
      {
        name: "Japanese command prohibition",
        action: proposal("run_command", {}, shellRead()),
        userText: "コマンドを実行しないでください。",
      },
      {
        name: "Spanish command prohibition",
        action: proposal("run_command", {}, shellRead()),
        userText: "No ejecutes comandos.",
      },
    ];

    for (const testCase of cases) {
      const constraints = parseActionConstraints(testCase.userText);
      assert.isNotEmpty(constraints, `${testCase.name} should be parsed`);
      for (const mode of ["safe", "auto", "yolo"] as const) {
        assert.equal(
          decide(testCase.action, {
            mode,
            userText: testCase.userText,
            constraints,
          }).kind,
          "block",
          `${testCase.name} in ${mode}`,
        );
      }
    }
  });

  it("keeps relative target exclusions scoped in supported query languages", function () {
    const cases = [
      "Create a Zotero note. Do not run commands or modify other items.",
      "请创建一条 Zotero 笔记。不要运行命令，也不要修改其他条目。",
      "Zoteroノートを作成してください。コマンドを実行せず、他の項目を変更しないでください。",
      "Crea una nota en Zotero. No ejecutes comandos ni modifiques otros elementos.",
    ];

    for (const userText of cases) {
      const constraints = parseActionConstraints(userText);
      assert.deepEqual(
        constraints.map((entry) => entry.kind),
        ["deny_mechanisms"],
        userText,
      );
      assert.equal(
        decide(proposal("write_note", {}, noteWrite()), {
          userText,
          constraints,
        }).kind,
        "execute",
        userText,
      );
      assert.equal(
        decide(proposal("run_command", {}, shellRead()), {
          userText,
          constraints,
        }).kind,
        "block",
        userText,
      );
    }
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
