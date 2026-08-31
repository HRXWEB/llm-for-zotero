import { readFileSync } from "node:fs";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  buildCodexPermissionOption,
  buildPermissionAccessibleLabel,
  getOriginalPermissionOptions,
} from "../src/shared/permissionOptions";
import { buildClaudePermissionOption } from "../src/shared/permissionOptions";
import { resolvePermissionSurface } from "../src/modules/contextPanel/footerPermissionControl";
import {
  getClaudePermissionModePref,
  setClaudePermissionModePref,
} from "../src/claudeCode/prefs";
import {
  getCodexPermissionProfilePref,
  setCodexPermissionProfilePref,
} from "../src/codexAppServer/prefs";
import {
  getAgentLibraryWriteMode,
  setAgentLibraryWriteMode,
} from "../src/agent/libraryWriteMode";
import { migrateClaudePermissionMode } from "../src/utils/migrations";
import { fetchClaudePermissionModeCatalog } from "../src/claudeCode/permissionModes";
import { reconcileClaudePermissionMode } from "../src/claudeCode/permissionModes";
import {
  listCodexPermissionProfiles,
  validateCodexPermissionSelection,
} from "../src/codexAppServer/permissionProfiles";
import type { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

const PREFIX = "extensions.zotero.llmforzotero.";

describe("provider permission modes", function () {
  const originalZotero = globalThis.Zotero;
  const originalServices = (globalThis as any).Services;
  let prefs: Map<string, unknown>;
  let userPrefs: Set<string>;

  beforeEach(function () {
    prefs = new Map();
    userPrefs = new Set();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
          userPrefs.add(key);
        },
      },
    };
    (globalThis as any).Services = {
      prefs: {
        prefHasUserValue: (key: string) => userPrefs.has(key),
      },
    };
  });

  after(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).Services = originalServices;
  });

  it("migrates the legacy Claude modes once without overwriting a new preference", function () {
    prefs.set(`${PREFIX}agentPermissionMode`, "yolo");
    userPrefs.add(`${PREFIX}agentPermissionMode`);
    migrateClaudePermissionMode();
    assert.equal(
      prefs.get(`${PREFIX}claudeCodePermissionMode`),
      "bypassPermissions",
    );
    assert.equal(
      prefs.get(`${PREFIX}claudeCodePermissionModeMigrationDone`),
      true,
    );

    prefs.clear();
    userPrefs.clear();
    prefs.set(`${PREFIX}agentPermissionMode`, "safe");
    userPrefs.add(`${PREFIX}agentPermissionMode`);
    prefs.set(`${PREFIX}claudeCodePermissionMode`, "plan");
    userPrefs.add(`${PREFIX}claudeCodePermissionMode`);
    migrateClaudePermissionMode();
    assert.equal(prefs.get(`${PREFIX}claudeCodePermissionMode`), "plan");
  });

  it("round-trips provider preferences without cross-writing", function () {
    setAgentLibraryWriteMode("yolo");
    setClaudePermissionModePref("dontAsk");
    setCodexPermissionProfilePref(":custom_profile-with-long-name");

    assert.equal(getAgentLibraryWriteMode(), "yolo");
    assert.equal(getClaudePermissionModePref(), "dontAsk");
    assert.equal(
      getCodexPermissionProfilePref(),
      ":custom_profile-with-long-name",
    );
    assert.deepEqual(
      Array.from(prefs.keys()).sort(),
      [
        `${PREFIX}agentLibraryWriteMode`,
        `${PREFIX}claudeCodePermissionMode`,
        `${PREFIX}codexAppServerPermissionProfile`,
      ].sort(),
    );
  });

  it("resolves a provider-exclusive footer matrix", function () {
    const common = {
      originalSelectedId: "auto" as const,
      claudeSelectedId: "default" as const,
      codexSelectedId: ":read-only",
    };
    assert.equal(
      resolvePermissionSurface({
        ...common,
        conversationSystem: "upstream",
        runtimeMode: "chat",
      }).kind,
      "hidden",
    );
    const original = resolvePermissionSurface({
      ...common,
      conversationSystem: "upstream",
      runtimeMode: "agent",
    });
    assert.deepEqual(
      original.kind === "original"
        ? original.options.map((entry) => entry.id)
        : [],
      ["safe", "auto", "yolo", "plan"],
    );
    const claudeOptions = [
      "plan",
      "dontAsk",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ].map((id) => buildClaudePermissionOption({ id: id as any }));
    const claude = resolvePermissionSurface({
      ...common,
      conversationSystem: "claude_code",
      runtimeMode: "agent",
      claudeOptions,
    });
    assert.deepEqual(
      claude.kind === "claude" ? claude.options.map((entry) => entry.id) : [],
      claudeOptions.map((entry) => entry.id),
    );
    const codexOptions = [
      buildCodexPermissionOption({
        id: ":read-only",
        description: "Read only",
        allowed: true,
      }),
      buildCodexPermissionOption({
        id: ":team_custom-profile",
        description: "Team policy",
        allowed: true,
      }),
    ];
    const codex = resolvePermissionSurface({
      ...common,
      conversationSystem: "codex",
      runtimeMode: "chat",
      codexOptions,
    });
    assert.deepEqual(
      codex.kind === "codex" ? codex.options.map((entry) => entry.id) : [],
      [":read-only", ":team_custom-profile"],
    );
  });

  it("uses provider-local labels and semantic risks", function () {
    const originalAuto = getOriginalPermissionOptions().find(
      (entry) => entry.id === "auto",
    )!;
    const claudeAuto = buildClaudePermissionOption({ id: "auto" });
    const edits = buildClaudePermissionOption({ id: "acceptEdits" });
    const dontAsk = buildClaudePermissionOption({ id: "dontAsk" });
    const bypass = buildClaudePermissionOption({ id: "bypassPermissions" });
    const full = buildCodexPermissionOption({
      id: ":danger-full-access",
      description: "No sandbox",
      allowed: true,
    });
    const custom = buildCodexPermissionOption({
      id: ":a-very_long-custom_profile-name",
      description: "Exact custom policy",
      allowed: true,
    });
    assert.equal(originalAuto.risk, "standard");
    assert.equal(claudeAuto.risk, "elevated");
    assert.equal(edits.compactLabel, "edits");
    assert.equal(dontAsk.compactLabel, "no prompts");
    assert.equal(bypass.compactLabel, "bypass");
    assert.equal(full.compactLabel, "full access");
    assert.equal(custom.fullLabel, "a very long custom profile name");
    assert.equal(custom.id, ":a-very_long-custom_profile-name");
    assert.include(buildPermissionAccessibleLabel(custom), custom.id);

    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.include(css, "max-width: 14ch");
    assert.include(css, 'data-permission-mode="auto"');
    assert.notInclude(css, ".llm-permission-option-level");
  });

  it("requires the Claude bridge capability and preserves managed availability", async function () {
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/healthz")) {
        return new Response(
          JSON.stringify({ ok: true, capabilities: ["permission_modes_v1"] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          configuredDefaultMode: "plan",
          modes: [
            { id: "default", description: "Default", available: true },
            {
              id: "auto",
              description: "Auto",
              available: false,
              disabledReason: "Disabled by policy",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const catalog = await fetchClaudePermissionModeCatalog({
      bridgeUrl: "http://127.0.0.1:19787",
      settingSources: ["user"],
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(catalog.configuredDefaultMode, "plan");
    assert.equal(
      catalog.options.find((entry) => entry.id === "auto")?.available,
      false,
    );
    assert.deepEqual(
      reconcileClaudePermissionMode({
        selectedId: "bypassPermissions",
        options: catalog.options,
      }).selectedId,
      "default",
    );
  });

  it("paginates Codex profiles and fails closed for missing or legacy selections", async function () {
    const calls: unknown[] = [];
    const proc = {
      async sendRequest(_method: string, params: Record<string, unknown>) {
        calls.push(params);
        return params.cursor
          ? {
              data: [
                { id: "custom_team", description: "Team", allowed: false },
              ],
            }
          : {
              data: [{ id: ":read-only", description: "Read", allowed: true }],
              nextCursor: "next",
            };
      },
    } as CodexAppServerProcess;
    const catalog = await listCodexPermissionProfiles({
      proc,
      cwd: "/runtime",
    });
    assert.equal(catalog.kind, "profiles");
    assert.deepEqual(
      catalog.profiles.map((entry) => entry.id),
      [":read-only", "custom_team"],
    );
    assert.lengthOf(calls, 2);
    assert.throws(
      () =>
        validateCodexPermissionSelection({
          selectedId: "custom_team",
          catalog,
        }),
      /Choose an allowed/,
    );

    const legacy = await listCodexPermissionProfiles({
      proc: {
        async sendRequest() {
          throw new Error("Method not found (-32601)");
        },
      } as CodexAppServerProcess,
    });
    assert.equal(legacy.kind, "legacy");
    assert.throws(
      () =>
        validateCodexPermissionSelection({
          selectedId: ":workspace",
          catalog: legacy,
        }),
      /supports only Read only/,
    );
  });
});
