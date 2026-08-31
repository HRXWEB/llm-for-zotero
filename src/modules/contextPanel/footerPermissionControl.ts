import {
  getAgentLibraryWriteMode,
  setAgentLibraryWriteMode,
} from "../../agent/libraryWriteMode";
import type { AgentLibraryWriteMode } from "../../shared/agentLibraryWriteMode";
import type { ConversationSystem } from "../../shared/types";
import { t } from "../../utils/i18n";
import type { ChatRuntimeMode } from "./types";
import {
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";

export const FOOTER_PERMISSION_MENU_OPEN_CLASS = "llm-permission-menu-open";

export const FOOTER_PERMISSION_MODE_OPTIONS = [
  { mode: "safe", available: true },
  { mode: "auto", available: true },
  { mode: "yolo", available: true },
  { mode: "plan", available: false },
] as const;

export function shouldShowFooterPermissionControl(params: {
  conversationSystem: ConversationSystem;
  runtimeMode: ChatRuntimeMode;
}): boolean {
  return (
    params.conversationSystem === "upstream" && params.runtimeMode === "agent"
  );
}

type FooterPermissionControlDeps = {
  body: Element;
  control: HTMLDivElement | null;
  button: HTMLButtonElement | null;
  menu: HTMLDivElement | null;
  getConversationSystem: () => ConversationSystem;
  getRuntimeMode: () => ChatRuntimeMode;
};

export type FooterPermissionControl = {
  sync: () => void;
  close: () => void;
  dispose: () => void;
};

export function attachFooterPermissionControl(
  deps: FooterPermissionControlDeps,
): FooterPermissionControl {
  const { body, control, button, menu } = deps;
  const panelDoc = body.ownerDocument;

  const close = () => {
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, false);
    button?.setAttribute("aria-expanded", "false");
  };

  if (!control || !button || !menu || !panelDoc) {
    return { sync: () => {}, close, dispose: () => {} };
  }

  const sync = () => {
    const visible = shouldShowFooterPermissionControl({
      conversationSystem: deps.getConversationSystem(),
      runtimeMode: deps.getRuntimeMode(),
    });
    control.style.display = visible ? "inline-flex" : "none";
    if (!visible) close();

    const mode = getAgentLibraryWriteMode();
    button.textContent = mode;
    button.dataset.mode = mode;
    button.title = `${t("Permission mode")}: ${mode}`;
    button.setAttribute("aria-label", `${t("Permission mode")}: ${mode}`);

    for (const option of Array.from(
      menu.querySelectorAll(".llm-permission-option"),
    ) as HTMLButtonElement[]) {
      const selected = option.dataset.permissionMode === mode;
      option.setAttribute("aria-checked", selected ? "true" : "false");
      option.classList.toggle("llm-permission-option-selected", selected);
    }
  };

  const open = () => {
    sync();
    if (control.style.display === "none") return;
    positionFloatingMenu(body, menu, button, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });
    if (menu.scrollHeight <= menu.clientHeight) {
      menu.style.overflowY = "hidden";
    }
    setFloatingMenuOpen(menu, FOOTER_PERMISSION_MENU_OPEN_CLASS, true);
    button.setAttribute("aria-expanded", "true");
  };

  const onButtonClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.style.display === "none") {
      open();
    } else {
      close();
    }
  };
  const stopMenuPointerEvent = (event: Event) => event.stopPropagation();
  const onMenuClick = (event: Event) => {
    const target = (event.target as Element | null)?.closest(
      ".llm-permission-option",
    ) as HTMLButtonElement | null;
    if (!target || target.disabled) return;
    const mode = target.dataset.permissionMode;
    if (mode !== "safe" && mode !== "auto" && mode !== "yolo") return;
    setAgentLibraryWriteMode(mode as AgentLibraryWriteMode);
    sync();
    close();
  };
  const onOutsidePointerDown = (event: Event) => {
    if (menu.style.display === "none") return;
    const target = event.target as Node | null;
    if (target && (control.contains(target) || menu.contains(target))) return;
    close();
  };
  const onEscape = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape" || menu.style.display === "none") {
      return;
    }
    close();
    button.focus();
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };

  button.addEventListener("click", onButtonClick);
  menu.addEventListener("pointerdown", stopMenuPointerEvent);
  menu.addEventListener("mousedown", stopMenuPointerEvent);
  menu.addEventListener("click", onMenuClick);
  panelDoc.addEventListener("pointerdown", onOutsidePointerDown, true);
  panelDoc.addEventListener("keydown", onEscape, true);

  sync();

  return {
    sync,
    close,
    dispose: () => {
      button.removeEventListener("click", onButtonClick);
      menu.removeEventListener("pointerdown", stopMenuPointerEvent);
      menu.removeEventListener("mousedown", stopMenuPointerEvent);
      menu.removeEventListener("click", onMenuClick);
      panelDoc.removeEventListener("pointerdown", onOutsidePointerDown, true);
      panelDoc.removeEventListener("keydown", onEscape, true);
    },
  };
}
