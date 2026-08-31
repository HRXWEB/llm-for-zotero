import type { ConversationSystem } from "../../shared/types";
import type { AgentLibraryWriteMode } from "../../shared/agentLibraryWriteMode";
import type { ClaudePermissionMode } from "../../shared/claudePermissionMode";
import {
  buildCodexPermissionOption,
  buildPermissionAccessibleLabel,
  getOriginalPermissionOptions,
  normalizeCodexProfileLabel,
  type PermissionOption,
} from "../../shared/permissionOptions";
import {
  getAgentLibraryWriteMode,
  setAgentLibraryWriteMode,
} from "../../agent/libraryWriteMode";
import {
  getClaudeBridgeUrl,
  getClaudePermissionModePref,
  getClaudeSettingSourcesByPref,
  setClaudePermissionModePref,
} from "../../claudeCode/prefs";
import {
  fetchClaudePermissionModeCatalog,
  reconcileClaudePermissionMode,
} from "../../claudeCode/permissionModes";
import {
  getCodexPermissionProfilePref,
  setCodexPermissionProfilePref,
} from "../../codexAppServer/prefs";
import { getConfiguredCodexAppServerBinaryPath } from "../../codexAppServer/binaryPath";
import { listCodexPermissionProfiles } from "../../codexAppServer/permissionProfiles";
import { resolveCodexNativeRuntimeCwd } from "../../codexAppServer/runtimeCwd";
import {
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";

export const FOOTER_PERMISSION_MENU_OPEN_CLASS = "llm-permission-menu-open";

const ORIGINAL_PLAN_PLACEHOLDER: PermissionOption = {
  provider: "original",
  id: "plan",
  fullLabel: "Plan",
  compactLabel: "plan",
  levelLabel: "Restricted",
  description: "Plan mode is not available for the Original Agent yet.",
  risk: "restricted",
  available: false,
  disabledReason: "Plan mode is not available for the Original Agent yet.",
};

export type PermissionSurface =
  | { kind: "hidden" }
  | { kind: "original"; selectedId: string; options: PermissionOption[] }
  | { kind: "claude"; selectedId: string; options: PermissionOption[] }
  | { kind: "codex"; selectedId: string; options: PermissionOption[] }
  | {
      kind: "loading";
      provider: "claude" | "codex";
      message: string;
    }
  | {
      kind: "error";
      provider: "claude" | "codex";
      message: string;
    };

type PermissionCatalogLoaders = {
  loadClaudeOptions: () => Promise<PermissionOption[]>;
  loadCodexOptions: () => Promise<PermissionOption[]>;
};

let permissionCatalogLoadersForTests: PermissionCatalogLoaders | null = null;

export function setFooterPermissionCatalogLoadersForTests(
  loaders?: PermissionCatalogLoaders,
): void {
  permissionCatalogLoadersForTests = loaders ?? null;
}

type RuntimeMode = "chat" | "agent";

export function resolvePermissionSurface(params: {
  conversationSystem: ConversationSystem;
  runtimeMode: RuntimeMode;
  originalSelectedId: AgentLibraryWriteMode;
  claudeSelectedId: ClaudePermissionMode;
  codexSelectedId: string;
  claudeOptions?: PermissionOption[];
  codexOptions?: PermissionOption[];
}): PermissionSurface {
  if (params.conversationSystem === "claude_code") {
    return params.claudeOptions
      ? {
          kind: "claude",
          selectedId: params.claudeSelectedId,
          options: params.claudeOptions,
        }
      : {
          kind: "loading",
          provider: "claude",
          message: "Loading permissions…",
        };
  }
  if (params.conversationSystem === "codex") {
    return params.codexOptions
      ? {
          kind: "codex",
          selectedId: params.codexSelectedId,
          options: params.codexOptions,
        }
      : { kind: "loading", provider: "codex", message: "Loading permissions…" };
  }
  if (params.runtimeMode !== "agent") return { kind: "hidden" };
  return {
    kind: "original",
    selectedId: params.originalSelectedId,
    options: [...getOriginalPermissionOptions(), ORIGINAL_PLAN_PLACEHOLDER],
  };
}

export function attachFooterPermissionControl(params: {
  body: Element;
  control: HTMLDivElement | null;
  button: HTMLButtonElement | null;
  menu: HTMLDivElement | null;
  getConversationSystem: () => ConversationSystem;
  getRuntimeMode: () => RuntimeMode;
  onWarning?: (message: string) => void;
  loadClaudeOptions?: () => Promise<PermissionOption[]>;
  loadCodexOptions?: () => Promise<PermissionOption[]>;
}) {
  const { control, button, menu } = params;
  let generation = 0;
  let activeProvider: ConversationSystem | null = null;
  let disposed = false;
  let surface: PermissionSurface = { kind: "hidden" };
  let cachedCatalog: {
    provider: "claude_code" | "codex";
    key: string;
    options: PermissionOption[];
  } | null = null;
  let inFlightCatalog: {
    provider: "claude_code" | "codex";
    key: string;
    promise: Promise<PermissionOption[]>;
  } | null = null;

  const close = () => {
    if (!menu || !button) return;
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, false);
    menu.replaceChildren();
    button.setAttribute("aria-expanded", "false");
  };

  const render = (next: PermissionSurface) => {
    surface = next;
    if (!control || !button || !menu) return;
    close();
    if (next.kind === "hidden") {
      control.style.display = "none";
      return;
    }
    control.style.display = "inline-flex";
    if (next.kind === "loading" || next.kind === "error") {
      button.disabled = true;
      button.textContent = next.kind === "loading" ? "loading…" : "unavailable";
      button.title = next.message;
      button.setAttribute("aria-label", next.message);
      return;
    }
    button.disabled = false;
    const selected = next.options.find(
      (option) => option.id === next.selectedId,
    );
    const fallback: PermissionOption = {
      provider: next.kind,
      id: next.selectedId,
      fullLabel:
        next.kind === "codex"
          ? normalizeCodexProfileLabel(next.selectedId)
          : next.selectedId,
      compactLabel:
        next.kind === "codex"
          ? normalizeCodexProfileLabel(next.selectedId)
          : next.selectedId,
      levelLabel: "Custom",
      description: "The saved permission value is not available.",
      risk: "custom",
      available: false,
    };
    const selectedOption = selected ?? fallback;
    button.textContent = selectedOption.compactLabel;
    button.title = buildPermissionAccessibleLabel(selectedOption);
    button.setAttribute(
      "aria-label",
      buildPermissionAccessibleLabel(selectedOption),
    );

    for (const option of next.options) {
      const row = params.body.ownerDocument.createElement("button");
      row.type = "button";
      row.className = "llm-permission-option";
      row.dataset.permissionMode = option.id;
      row.dataset.permissionId = option.id;
      row.disabled = !option.available;
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(option.id === next.selectedId));
      row.classList.toggle(
        "llm-permission-option-selected",
        option.id === next.selectedId,
      );
      row.setAttribute("aria-label", buildPermissionAccessibleLabel(option));
      row.title =
        option.disabledReason || buildPermissionAccessibleLabel(option);
      row.textContent = option.fullLabel;
      row.addEventListener("click", () => {
        if (!option.available) return;
        if (next.kind === "original") {
          setAgentLibraryWriteMode(option.id as AgentLibraryWriteMode);
        } else if (next.kind === "claude") {
          setClaudePermissionModePref(option.id as ClaudePermissionMode);
        } else {
          setCodexPermissionProfilePref(option.id);
        }
        close();
        void sync();
      });
      menu.appendChild(row);
    }
  };

  const loadClaude =
    params.loadClaudeOptions ??
    permissionCatalogLoadersForTests?.loadClaudeOptions ??
    (async () => {
      const catalog = await fetchClaudePermissionModeCatalog({
        bridgeUrl: getClaudeBridgeUrl(),
        settingSources: getClaudeSettingSourcesByPref(),
      });
      return catalog.options;
    });
  const loadCodex =
    params.loadCodexOptions ??
    permissionCatalogLoadersForTests?.loadCodexOptions ??
    (async () => {
      const catalog = await listCodexPermissionProfiles({
        codexPath: getConfiguredCodexAppServerBinaryPath(),
      });
      return catalog.profiles.map(buildCodexPermissionOption);
    });

  const sync = async () => {
    if (disposed) return;
    const currentGeneration = ++generation;
    const provider = params.getConversationSystem();
    if (provider !== activeProvider) {
      close();
      activeProvider = provider;
      cachedCatalog = null;
      inFlightCatalog = null;
    }
    const common = {
      conversationSystem: provider,
      runtimeMode: params.getRuntimeMode(),
      originalSelectedId: getAgentLibraryWriteMode(),
      claudeSelectedId: getClaudePermissionModePref(),
      codexSelectedId: getCodexPermissionProfilePref(),
    };
    if (provider === "upstream") {
      render(resolvePermissionSurface(common));
      return;
    }
    const catalogKey =
      provider === "claude_code"
        ? `${getClaudeBridgeUrl()}\u0000${getClaudeSettingSourcesByPref().join(",")}`
        : `${getConfiguredCodexAppServerBinaryPath()}\u0000${resolveCodexNativeRuntimeCwd()}`;
    let options =
      cachedCatalog?.provider === provider && cachedCatalog.key === catalogKey
        ? cachedCatalog.options
        : null;
    if (!options) render(resolvePermissionSurface(common));
    let requestedPromise: Promise<PermissionOption[]> | null = null;
    try {
      if (!options) {
        let catalogPromise =
          inFlightCatalog?.provider === provider &&
          inFlightCatalog.key === catalogKey
            ? inFlightCatalog.promise
            : null;
        if (!catalogPromise) {
          catalogPromise =
            provider === "claude_code" ? loadClaude() : loadCodex();
          inFlightCatalog = {
            provider,
            key: catalogKey,
            promise: catalogPromise,
          };
        }
        requestedPromise = catalogPromise;
        options = await catalogPromise;
      }
      if (
        disposed ||
        currentGeneration !== generation ||
        provider !== params.getConversationSystem()
      ) {
        return;
      }
      cachedCatalog = { provider, key: catalogKey, options };
      if (inFlightCatalog?.promise === requestedPromise) inFlightCatalog = null;
      if (provider === "claude_code") {
        const reconciliation = reconcileClaudePermissionMode({
          selectedId: getClaudePermissionModePref(),
          options,
        });
        if (reconciliation.selectedId !== getClaudePermissionModePref()) {
          setClaudePermissionModePref(reconciliation.selectedId);
          if (reconciliation.warning)
            params.onWarning?.(reconciliation.warning);
        }
        render(
          resolvePermissionSurface({
            ...common,
            claudeSelectedId: reconciliation.selectedId,
            claudeOptions: options,
          }),
        );
      } else {
        render(resolvePermissionSurface({ ...common, codexOptions: options }));
      }
    } catch (error) {
      if (inFlightCatalog?.promise === requestedPromise) inFlightCatalog = null;
      if (
        disposed ||
        currentGeneration !== generation ||
        provider !== params.getConversationSystem()
      ) {
        return;
      }
      render({
        kind: "error",
        provider: provider === "claude_code" ? "claude" : "codex",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onButtonClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!button || !menu || button.disabled) return;
    const open = button.getAttribute("aria-expanded") === "true";
    if (open) {
      close();
      return;
    }
    if (
      surface.kind === "hidden" ||
      surface.kind === "loading" ||
      surface.kind === "error"
    ) {
      return;
    }
    render(surface);
    positionFloatingMenu(params.body, menu, button, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });
    if (menu.scrollHeight <= menu.clientHeight) {
      menu.style.overflowY = "hidden";
    }
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, true);
    button.setAttribute("aria-expanded", "true");
  };
  const stopMenuPointerEvent = (event: Event) => event.stopPropagation();
  const onOutsidePointerDown = (event: Event) => {
    if (!menu || menu.style.display === "none") return;
    const target = event.target as Node | null;
    if (target && (control?.contains(target) || menu.contains(target))) return;
    close();
  };
  const onEscape = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (
      keyboardEvent.key !== "Escape" ||
      !menu ||
      menu.style.display === "none"
    ) {
      return;
    }
    close();
    button?.focus();
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };
  button?.addEventListener("click", onButtonClick);
  menu?.addEventListener("pointerdown", stopMenuPointerEvent);
  menu?.addEventListener("mousedown", stopMenuPointerEvent);
  params.body.ownerDocument.addEventListener(
    "pointerdown",
    onOutsidePointerDown,
    true,
  );
  params.body.ownerDocument.addEventListener("keydown", onEscape, true);

  return {
    sync,
    close,
    dispose() {
      disposed = true;
      generation += 1;
      close();
      button?.removeEventListener("click", onButtonClick);
      menu?.removeEventListener("pointerdown", stopMenuPointerEvent);
      menu?.removeEventListener("mousedown", stopMenuPointerEvent);
      params.body.ownerDocument.removeEventListener(
        "pointerdown",
        onOutsidePointerDown,
        true,
      );
      params.body.ownerDocument.removeEventListener("keydown", onEscape, true);
    },
  };
}
