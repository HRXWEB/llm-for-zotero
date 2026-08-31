import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestPermissionSurfaceDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value, true);
      }
    }
  }
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function assertRows(
  surface: WorkflowTestPermissionSurfaceDiagnostics,
  expected: string[],
): void {
  assert.isTrue(surface.visible, JSON.stringify(surface));
  assert.isFalse(surface.disabled, JSON.stringify(surface));
  assert.deepEqual(
    surface.rows.map((row) => row.id),
    expected,
    JSON.stringify(surface),
  );
}

describe("workflow: provider-aware permission modes", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  it("keeps provider rows, preferences, and delayed catalogs isolated in panel and standalone", async function () {
    await withPrefs(
      {
        enableAgentMode: true,
        enableClaudeCodeMode: true,
        enableCodexAppServerMode: true,
        conversationSystem: "upstream",
        agentLibraryWriteMode: "safe",
        claudeCodePermissionMode: "default",
        codexAppServerPermissionProfile: ":read-only",
      },
      async () => {
        api.configurePermissionCatalogs({ delayFirstCodex: true });
        fixture = await api.createPaperWithPdfFixture({
          title: "Permission Mode Workflow Parent",
          pdfTitle: "Permission Mode Workflow PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);

        if (!api.getPanelPermissionSurface(panel.panelId).visible) {
          await api.clickPanelRuntimeModeToggle(panel.panelId);
        }
        assertRows(api.getPanelPermissionSurface(panel.panelId), [
          "safe",
          "auto",
          "yolo",
          "plan",
        ]);
        const originalPanel = api.getPanelPermissionSurface(panel.panelId);
        assert.deepEqual(
          originalPanel.rows.map((row) => row.label),
          ["Safe", "Auto", "Yolo", "Plan"],
        );
        assert.deepEqual(
          originalPanel.rows.map((row) => row.level),
          ["", "", "", ""],
        );
        assert.isTrue(originalPanel.rows.at(-1)?.disabled);
        const openPanelMenu = await api.clickPanelPermissionToggle(
          panel.panelId,
        );
        assert.isTrue(openPanelMenu.expanded, JSON.stringify(openPanelMenu));
        assert.isTrue(openPanelMenu.menuVisible, JSON.stringify(openPanelMenu));

        await api.clickPanelSystemToggle(panel.panelId, "claude_code");
        assertRows(api.getPanelPermissionSurface(panel.panelId), [
          "plan",
          "dontAsk",
          "default",
          "acceptEdits",
          "auto",
          "bypassPermissions",
        ]);
        const afterClaude = await api.clickPanelPermissionOption(
          panel.panelId,
          "bypassPermissions",
        );
        assert.equal(afterClaude.compactLabel, "bypass");
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "bypassPermissions",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );
        assert.equal(
          Zotero.Prefs.get(
            `${PREF_PREFIX}.codexAppServerPermissionProfile`,
            true,
          ),
          ":read-only",
        );

        await api.clickPanelSystemToggle(panel.panelId, "codex");
        await api.clickPanelSystemToggle(panel.panelId, "claude_code");
        await api.clickPanelSystemToggle(panel.panelId, "codex");
        const currentCodex = api.getPanelPermissionSurface(panel.panelId);
        assertRows(currentCodex, [
          ":read-only",
          ":workspace",
          ":danger-full-access",
          ":team_custom_profile",
        ]);
        await api.resolveDelayedCodexPermissionCatalog();
        const afterStaleResponse = api.getPanelPermissionSurface(panel.panelId);
        assertRows(afterStaleResponse, [
          ":read-only",
          ":workspace",
          ":danger-full-access",
          ":team_custom_profile",
        ]);
        assert.notInclude(
          afterStaleResponse.rows.map((row) => row.id),
          ":stale-profile",
        );

        const afterCodex = await api.clickPanelPermissionOption(
          panel.panelId,
          ":workspace",
        );
        assert.equal(afterCodex.compactLabel, "workspace");
        assert.equal(
          Zotero.Prefs.get(
            `${PREF_PREFIX}.codexAppServerPermissionProfile`,
            true,
          ),
          ":workspace",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "bypassPermissions",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );

        Zotero.Prefs.set(`${PREF_PREFIX}.conversationSystem`, "upstream", true);
        api.configurePermissionCatalogs();
        await api.openStandaloneForItem(fixture.parentItemId);
        assertRows(api.getStandalonePermissionSurface(), [
          "safe",
          "auto",
          "yolo",
          "plan",
        ]);
        assert.isTrue(
          api.getStandalonePermissionSurface().rows.at(-1)?.disabled,
        );
        const openStandaloneMenu = await api.clickStandalonePermissionToggle();
        assert.isTrue(
          openStandaloneMenu.expanded,
          JSON.stringify(openStandaloneMenu),
        );
        assert.isTrue(
          openStandaloneMenu.menuVisible,
          JSON.stringify(openStandaloneMenu),
        );
        await api.clickStandaloneSystemToggle("claude_code");
        assertRows(api.getStandalonePermissionSurface(), [
          "plan",
          "dontAsk",
          "default",
          "acceptEdits",
          "auto",
          "bypassPermissions",
        ]);
        await api.clickStandalonePermissionOption("acceptEdits");
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "acceptEdits",
        );
        assert.equal(
          Zotero.Prefs.get(
            `${PREF_PREFIX}.codexAppServerPermissionProfile`,
            true,
          ),
          ":workspace",
        );
        await api.clickStandaloneSystemToggle("codex");
        assertRows(api.getStandalonePermissionSurface(), [
          ":read-only",
          ":workspace",
          ":danger-full-access",
          ":team_custom_profile",
        ]);
        const standaloneCodex = await api.clickStandalonePermissionOption(
          ":team_custom_profile",
        );
        assert.equal(standaloneCodex.compactLabel, "team custom profile");
        assert.include(standaloneCodex.accessibleName, ":team_custom_profile");
        assert.equal(
          Zotero.Prefs.get(
            `${PREF_PREFIX}.codexAppServerPermissionProfile`,
            true,
          ),
          ":team_custom_profile",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "acceptEdits",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );
      },
    );
  });
});
