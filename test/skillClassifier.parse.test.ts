import { assert } from "chai";
import {
  canUseSkillClassifierModel,
  detectTurnIntent as detectTurnIntentResolved,
  parseClassifiedTurnIntent,
  parseClassifierResponse,
  parseSkillRouterResponse,
  resolvePlanSkillRoutingReceipt,
} from "../src/agent/model/skillClassifier";
import { resolveSkillRouting as resolveSkillRoutingResolved } from "../src/agent/skills/routing";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const completeOutcome = (text: string) => ({
  text,
  completion: { status: "complete" as const },
});

function normalizeRequest(input: AgentRuntimeRequestInput) {
  return resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    ...input,
  });
}

async function detectTurnIntent(
  ...args: Parameters<typeof detectTurnIntentResolved>
): ReturnType<typeof detectTurnIntentResolved> {
  return detectTurnIntentResolved(normalizeRequest(args[0]), ...args.slice(1));
}

function resolveSkillRouting(
  ...args: Parameters<typeof resolveSkillRoutingResolved>
): ReturnType<typeof resolveSkillRoutingResolved> {
  return resolveSkillRoutingResolved(
    normalizeRequest(args[0]),
    ...args.slice(1),
  );
}

const SKILLS: AgentSkill[] = [
  {
    id: "write-note",
    description: "Create or edit notes",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "compare-papers",
    description: "Compare two papers",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "analyze-figures",
    description: "Analyze figures",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
];

describe("parseClassifierResponse", function () {
  it("returns the listed skill IDs for a clean JSON response", function () {
    const raw = '{"skillIds": ["write-note", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns an empty array when the classifier says no skills apply", function () {
    const raw = '{"skillIds": []}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), []);
  });

  it("tolerates surrounding prose or code fences", function () {
    const raw =
      'Sure, here is the classification:\n```json\n{"skillIds": ["compare-papers"]}\n```';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), ["compare-papers"]);
  });

  it("drops IDs that aren't in the known skill set", function () {
    const raw =
      '{"skillIds": ["write-note", "made-up-skill", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns null for completely malformed input (caller should fall back)", function () {
    assert.isNull(parseClassifierResponse("not JSON at all", SKILLS));
    assert.isNull(parseClassifierResponse("", SKILLS));
    assert.isNull(parseClassifierResponse('{"wrongKey": []}', SKILLS));
    assert.isNull(
      parseClassifierResponse('{"skillIds": "not-an-array"}', SKILLS),
    );
  });

  it("strips non-string entries from the skillIds array", function () {
    const raw = '{"skillIds": ["write-note", 42, null, "compare-papers"]}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), [
      "write-note",
      "compare-papers",
    ]);
  });

  it("does not route Codex app-server skill classification through the generic LLM client", function () {
    assert.isFalse(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "codex_app_server",
      }),
    );
    assert.isFalse(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "api_key",
      }),
    );
  });
});

describe("parseClassifierResponse unmatched pseudo-skill", function () {
  it("maps a lone unmatched to a positive empty match", function () {
    assert.deepEqual(
      parseClassifierResponse('{"skillIds": ["unmatched"]}', SKILLS),
      [],
    );
  });

  it("lets real picks win over a hedged unmatched", function () {
    assert.deepEqual(
      parseClassifierResponse(
        '{"skillIds": ["unmatched", "write-note"]}',
        SKILLS,
      ),
      ["write-note"],
    );
  });

  it("collapses hallucinated-only IDs to an empty match", function () {
    assert.deepEqual(
      parseClassifierResponse('{"skillIds": ["bogus-only"]}', SKILLS),
      [],
    );
  });
});

describe("parseClassifiedTurnIntent", function () {
  it("parses a typed document outcome and rejects an untyped one", function () {
    const parsed = parseClassifiedTurnIntent(
      '{"retrievalIntent":"none","deliverableIntent":"document","documentKind":"report","wantedSections":[]}',
    );
    assert.equal(parsed?.deliverableIntent, "document");
    assert.equal(parsed?.documentKind, "report");
    assert.isNull(
      parseClassifiedTurnIntent(
        '{"retrievalIntent":"none","deliverableIntent":"document","wantedSections":[]}',
      ),
    );
  });

  it("parses a valid full intent object", function () {
    const result = parseClassifiedTurnIntent(
      '{"skillIds":[],"retrievalIntent":"summarize","paperTargetIntent":"all_visible","externalSearchIntent":"both","wantedSections":["methods"],"queryLanguage":"zh"}',
    );

    assert.deepEqual(result, {
      retrievalIntent: "summarize",
      paperTargetIntent: "all_visible",
      externalSearchIntent: "both",
      wantedSections: ["methods"],
      queryLanguage: "zh",
      writeDisposition: "none",
      actionInterpretationSource: "classifier",
      actionIntents: [],
    });
  });

  it("keeps valid intent when paperTargetIntent is missing or malformed", function () {
    for (const paperTargetIntent of [undefined, "both"]) {
      const result = parseClassifiedTurnIntent(
        JSON.stringify({
          retrievalIntent: "summarize",
          paperTargetIntent,
          wantedSections: [],
          actionIntents: [],
        }),
      );
      assert.equal(result?.retrievalIntent, "summarize");
      assert.isUndefined(result?.paperTargetIntent);
    }
  });

  it("parses every bounded paperTargetIntent value", function () {
    for (const paperTargetIntent of [
      "active",
      "added",
      "all_visible",
      "unspecified",
    ] as const) {
      const result = parseClassifiedTurnIntent(
        JSON.stringify({
          retrievalIntent: "none",
          paperTargetIntent,
          wantedSections: [],
          actionIntents: [],
        }),
      );
      assert.equal(result?.paperTargetIntent, paperTargetIntent);
    }
  });

  it("returns null when retrievalIntent is missing or invalid", function () {
    assert.isNull(parseClassifiedTurnIntent('{"skillIds":[]}'));
    assert.isNull(parseClassifiedTurnIntent('{"retrievalIntent":"browse"}'));
    assert.isNull(parseClassifiedTurnIntent("not json"));
  });

  it("rejects required-write classifications without typed obligations", function () {
    assert.isNull(
      parseClassifiedTurnIntent(
        '{"retrievalIntent":"none","wantedSections":[],"writeDisposition":"required","actionIntents":[]}',
      ),
    );
  });

  it("filters unknown wantedSections entries", function () {
    const result = parseClassifiedTurnIntent(
      '{"retrievalIntent":"enumerate","wantedSections":["methods","bogus"]}',
    );

    assert.deepEqual(result?.wantedSections, ["methods"]);
  });

  for (const externalSearchIntent of [
    "none",
    "web",
    "literature",
    "both",
  ] as const) {
    it(`parses external search intent ${externalSearchIntent}`, function () {
      const result = parseClassifiedTurnIntent(
        JSON.stringify({
          retrievalIntent: "none",
          externalSearchIntent,
          wantedSections: [],
          queryLanguage: "es",
          actionIntents: [],
        }),
      );

      assert.equal(result?.externalSearchIntent, externalSearchIntent);
    });
  }

  it("omits a missing or invalid external search hint without losing other intent fields", function () {
    const missing = parseClassifiedTurnIntent(
      '{"retrievalIntent":"verify","wantedSections":["results"],"queryLanguage":"zh","actionIntents":[]}',
    );
    const invalid = parseClassifiedTurnIntent(
      '{"retrievalIntent":"verify","externalSearchIntent":"browse","wantedSections":["results"],"queryLanguage":"zh","actionIntents":[]}',
    );

    for (const result of [missing, invalid]) {
      assert.deepEqual(result, {
        retrievalIntent: "verify",
        wantedSections: ["results"],
        queryLanguage: "zh",
        writeDisposition: "none",
        actionInterpretationSource: "classifier",
        actionIntents: [],
      });
    }
  });
});

describe("detectTurnIntent", function () {
  it("activates no automatic skills when no model config is available", async function () {
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "some-model",
        apiBase: "",
      } as any,
      SKILLS,
    );

    assert.deepEqual(result, {
      skillIds: [],
      classifiedIntent: null,
      degraded: false,
      failureReason: "not_configured",
    });
  });

  it("still binds explicitly selected skills into a receipt without a router model", async function () {
    const result = await detectTurnIntent(
      {
        userText: "Use my selected workflow",
        forcedSkillIds: ["write-note"],
        model: "some-model",
        apiBase: "",
      } as any,
      SKILLS,
    );
    assert.deepEqual(result.skillIds, ["write-note"]);
    assert.equal(result.routingReceipt?.skills[0]?.source, "explicit");
  });

  it("passes the profile to a provider-safe utility classifier call", async function () {
    let captured: Record<string, unknown> = {};
    const profileOverride = {
      forModel: "gpt-5.4",
      limits: { outputTokens: 2_000 },
    };
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
        advanced: {
          temperature: 0,
          outputTokenLimit: { mode: "custom", tokens: 4_000 },
          profileOverride,
        },
      } as any,
      SKILLS,
      {
        llmCall: async (params) => {
          captured = params as unknown as Record<string, unknown>;
          return completeOutcome(
            '{"schemaVersion":1,"taskKind":"read","requestedScopes":["none"],"selections":[],"retrievalIntent":"none","externalSearchIntent":"none","wantedSections":[],"queryLanguage":"en"}',
          );
        },
      },
    );

    assert.isFalse(result.degraded);
    assert.deepEqual(captured.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.deepEqual(captured.profileOverride, profileOverride);
    assert.include(
      String(captured.prompt || ""),
      '"externalSearchIntent":"none|web|literature|both"',
    );
    assert.include(
      String(captured.prompt || ""),
      "requestedScopes describe what the user asks",
    );
    assert.include(
      String(captured.prompt || ""),
      "copy a short exact substring",
    );
    assert.include(String(captured.prompt || ""), "Available skills:");
    assert.include(String(captured.prompt || ""), "Runtime context:");
  });

  it("records unparseable classifier output as a distinct degradation reason", async function () {
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      { llmCall: async () => completeOutcome("not JSON") },
    );

    assert.isTrue(result.degraded);
    assert.equal(result.failureReason, "unparseable");
  });

  it("uses deterministic action parsing when the conditional action classifier is invalid", async function () {
    let calls = 0;
    const result = await detectTurnIntent(
      {
        userText: "create a Zotero note and export a markdown file",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async () => {
          calls += 1;
          return completeOutcome(
            calls === 1
              ? '{"schemaVersion":1,"taskKind":"write","requestedScopes":["note"],"selections":[],"retrievalIntent":"none","wantedSections":[]}'
              : '{"retrievalIntent":"none","wantedSections":[],"writeDisposition":"required","actionIntents":[]}',
          );
        },
      },
    );

    assert.isFalse(result.degraded);
    assert.equal(
      result.classifiedIntent?.actionInterpretationSource,
      "deterministic_fallback",
    );
    assert.isNotEmpty(result.classifiedIntent?.actionIntents || []);
  });

  it("rejects a classifier verb that contradicts an explicit tag removal", async function () {
    const result = await detectTurnIntent(
      {
        userText: 'Remove exactly the tag "reviewed" from item 41.',
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async (params) =>
          completeOutcome(
            String(params.prompt).includes("Classify only the exact mutation")
              ? '{"retrievalIntent":"none","wantedSections":[],"writeDisposition":"required","actionIntents":[{"operation":"set_item_tags","coverage":"one","targetKind":"papers","parameters":{"tags":["reviewed"]}}]}'
              : '{"schemaVersion":1,"taskKind":"write","requestedScopes":["none"],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
          ),
      },
    );

    assert.isFalse(result.degraded);
    assert.equal(
      result.classifiedIntent?.actionInterpretationSource,
      "deterministic_fallback",
    );
    assert.equal(
      result.classifiedIntent?.actionIntents[0]?.operation,
      "remove_tags",
    );
  });

  it("classifies collection union as rename, filing and collection-only removal", async function () {
    let actionPrompt = "";
    const actions = [
      {
        operation: "update_collection",
        coverage: "one",
        targetKind: "items",
        parameters: { collectionId: 98, collectionName: "geometry_memory" },
      },
      {
        operation: "move_to_collection",
        coverage: "all",
        targetKind: "papers",
        scope: {
          kind: "collection",
          path: "memory",
          includeDescendants: false,
        },
        scopeRole: "source",
        parameters: { destinationCollectionId: 98 },
      },
      {
        operation: "delete_collection",
        coverage: "one",
        targetKind: "items",
        parameters: { collectionId: 99, deleteItems: false },
      },
    ];
    const result = await detectTurnIntent(
      {
        userText:
          'Merge collections "geometry" (98) and "memory" (99) into one called "geometry_memory". Keep the union of their papers and preserve all other memberships. The old collection names should no longer exist.',
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async (params) => {
          if (
            !String(params.prompt).includes("Classify only the exact mutation")
          )
            return completeOutcome(
              '{"schemaVersion":1,"taskKind":"write","requestedScopes":["library-corpus"],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
            );
          actionPrompt = String(params.prompt);
          return completeOutcome(
            JSON.stringify({
              retrievalIntent: "none",
              wantedSections: [],
              writeDisposition: "required",
              actionIntents: actions,
            }),
          );
        },
      },
    );
    assert.include(actionPrompt, "A collection merge requires the full union");
    assert.include(actionPrompt, "deleteItems:false");
    assert.include(actionPrompt, "collectionId:number");
    assert.deepEqual(
      result.classifiedIntent?.actionIntents.map((action) => action.operation),
      ["update_collection", "move_to_collection", "delete_collection"],
    );
    assert.equal(
      result.classifiedIntent?.actionIntents[2].parameters?.deleteItems,
      false,
    );
  });

  it("distinguishes future filing destinations from existing source collections in action classification", async function () {
    let actionPrompt = "";
    const result = await detectTurnIntent(
      {
        userText:
          'Create "Geometry" under parent collection 74. Add existing papers 41 and 43 to Geometry. Do not create any papers or notes.',
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async (params) => {
          if (
            !String(params.prompt).includes("Classify only the exact mutation")
          )
            return completeOutcome(
              '{"schemaVersion":1,"taskKind":"write","requestedScopes":["library-corpus"],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
            );
          actionPrompt = String(params.prompt);
          return completeOutcome(
            JSON.stringify({
              retrievalIntent: "none",
              wantedSections: [],
              writeDisposition: "required",
              actionIntents: [
                {
                  operation: "create_collection",
                  coverage: "one",
                  targetKind: "items",
                  parameters: {
                    collectionName: "Geometry",
                    parentCollectionId: 74,
                  },
                },
                {
                  operation: "move_to_collection",
                  coverage: "some",
                  targetKind: "papers",
                  targetSelectors: [
                    { kind: "item_id", value: 41 },
                    { kind: "item_id", value: 43 },
                  ],
                  scopeRole: "destination",
                  scope: {
                    kind: "collection",
                    path: "Geometry",
                    includeDescendants: false,
                  },
                },
              ],
            }),
          );
        },
      },
    );
    assert.include(
      actionPrompt,
      'For collection filing without a named source, use scopeRole:"destination"',
    );
    assert.include(actionPrompt, "parentCollectionId");
    assert.equal(
      result.classifiedIntent?.actionInterpretationSource,
      "classifier",
    );
    assert.equal(
      result.classifiedIntent?.actionIntents[0].parameters?.parentCollectionId,
      74,
    );
    assert.equal(
      result.classifiedIntent?.actionIntents[1].scopeRole,
      "destination",
    );
    assert.deepEqual(
      result.classifiedIntent?.actionIntents[1].targetSelectors,
      [
        { kind: "item_id", value: 41 },
        { kind: "item_id", value: 43 },
      ],
    );
  });

  it("preserves an exact replacement classification for named papers instead of letting the additive fallback veto it", async function () {
    const titles = ["Geometry of population coding", "Memory and drift"];
    const result = await detectTurnIntent(
      {
        userText: `Apply exactly these tags to each of the papers titled "${titles[0]}", "${titles[1]}": coding, drift. Replace their old tags with this exact set. Do not tag any other paper.`,
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async (params) =>
          completeOutcome(
            String(params.prompt).includes("Classify only the exact mutation")
              ? JSON.stringify({
                  retrievalIntent: "none",
                  wantedSections: [],
                  writeDisposition: "required",
                  actionIntents: [
                    {
                      operation: "set_item_tags",
                      coverage: "some",
                      targetKind: "papers",
                      targetSelectors: titles.map((value) => ({
                        kind: "title",
                        value,
                      })),
                      parameters: { tags: ["coding", "drift"] },
                    },
                  ],
                })
              : '{"schemaVersion":1,"taskKind":"write","requestedScopes":["library-corpus"],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
          ),
      },
    );
    assert.equal(
      result.classifiedIntent?.actionInterpretationSource,
      "classifier",
    );
    assert.equal(
      result.classifiedIntent?.actionIntents[0]?.operation,
      "set_item_tags",
    );
    assert.deepEqual(
      (result.classifiedIntent?.actionIntents[0] as any)?.targetSelectors,
      titles.map((value) => ({ kind: "title", value })),
    );
    assert.deepEqual(
      result.classifiedIntent?.actionIntents[0]?.parameters?.tags,
      ["coding", "drift"],
    );
  });

  it("rejects a contextually impossible comparison even when the model selects it", async function () {
    const compareSkill: AgentSkill = {
      ...SKILLS[1],
      contexts: ["paper-set"],
      supersedes: [],
    };
    const result = await detectTurnIntent(
      {
        userText: "compare the local and long-range mechanisms",
        selectedPaperContexts: [{ itemId: 10, contextItemId: 100 }],
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      [compareSkill],
      {
        llmCall: async () =>
          completeOutcome(
            '{"schemaVersion":1,"taskKind":"read","requestedScopes":["single-paper"],"selections":[{"skillId":"compare-papers","requestedScope":"single-paper","evidenceText":"compare"}],"retrievalIntent":"none","wantedSections":[]}',
          ),
      },
    );
    assert.deepEqual(result.skillIds, []);
  });

  it("resolves multilingual evidence locally and reuses unchanged plan skills", async function () {
    const result = await detectTurnIntent(
      {
        userText: "请比较这两篇论文的方法",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      {
        llmCall: async () =>
          completeOutcome(
            '{"schemaVersion":1,"taskKind":"read","requestedScopes":["paper-set"],"selections":[{"skillId":"compare-papers","requestedScope":"paper-set","evidenceText":"比较这两篇论文"}],"retrievalIntent":"summarize","wantedSections":[]}',
          ),
      },
    );
    const activation = result.routingReceipt?.skills[0];
    assert.deepInclude(activation?.evidence, {
      text: "比较这两篇论文",
      start: 1,
      end: 8,
    });
    const reused = await resolvePlanSkillRoutingReceipt(
      result.routingReceipt
        ? {
            routerSchemaVersion: result.routingReceipt.routerSchemaVersion,
            skillManifestHash: result.routingReceipt.skillManifestHash,
            skills: result.routingReceipt.skills.map(
              ({ id, version, instructionHash, source }) => ({
                id,
                version,
                instructionHash,
                source,
              }),
            ),
          }
        : undefined,
      SKILLS,
    );
    assert.deepEqual(reused.skillIds, ["compare-papers"]);
  });
});

describe("parseSkillRouterResponse", function () {
  it("accepts exact evidence text without model-generated offsets", function () {
    const parsed = parseSkillRouterResponse(
      '{"schemaVersion":1,"taskKind":"read","requestedScopes":["paper-set"],"selections":[{"skillId":"compare-papers","requestedScope":"paper-set","evidenceText":"比较这两篇论文"}],"retrievalIntent":"summarize","wantedSections":[]}',
    );
    assert.equal(parsed?.selections[0]?.evidenceText, "比较这两篇论文");
  });

  it("rejects unknown schema versions and malformed occurrences", function () {
    assert.isNull(
      parseSkillRouterResponse(
        '{"schemaVersion":2,"taskKind":"read","requestedScopes":[],"selections":[],"retrievalIntent":"none","wantedSections":[]}',
      ),
    );
    assert.isNull(
      parseSkillRouterResponse(
        '{"schemaVersion":1,"taskKind":"read","requestedScopes":["single-paper"],"selections":[{"skillId":"x","requestedScope":"single-paper","evidenceText":"x","occurrence":-1}],"retrievalIntent":"none","wantedSections":[]}',
      ),
    );
  });
});

describe("resolveSkillRouting classified context gate", function () {
  const LIBRARY_ANALYSIS_SKILL: AgentSkill = {
    id: "library-analysis",
    description: "Analyze your whole library or collection with statistics",
    version: 1,
    patterns: [],
    contexts: ["library-corpus"],
    activation: "auto",
    instruction: "",
    source: "system",
  };

  it("accepts a classified library skill over a selected collection", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        selectedCollectionContexts: [
          { collectionId: 1, name: "C", libraryID: 1 },
        ],
        classifiedIntent: {
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      ["library-analysis"],
    );

    assert.include(resolution.matchedSkillIds, "library-analysis");
  });

  it("does not force library-analysis without a selected scope", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        classifiedIntent: {
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      [],
    );

    assert.notInclude(resolution.matchedSkillIds, "library-analysis");
  });
});
