import type { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import {
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
} from "../utils/codexAppServerProcess";
import type { CodexPermissionProfile } from "../shared/permissionOptions";
import {
  CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
  resolveCodexNativeRuntimeCwd,
} from "./runtimeCwd";
import { getCodexPermissionProfilePref } from "./prefs";

export type CodexPermissionProfileCatalog =
  | { kind: "profiles"; profiles: CodexPermissionProfile[] }
  | { kind: "legacy"; profiles: CodexPermissionProfile[] };

function isMethodNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /method not found|unknown method|no handler registered|-32601/i.test(
    message,
  );
}

function normalizePage(value: unknown): {
  profiles: CodexPermissionProfile[];
  nextCursor?: string;
} {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.profiles)
      ? record.profiles
      : Array.isArray(record.items)
        ? record.items
        : [];
  const profiles = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const entry = row as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return [];
    const allowed = entry.allowed !== false;
    return [
      {
        id,
        description:
          typeof entry.description === "string" ? entry.description.trim() : "",
        allowed,
        ...(!allowed
          ? {
              disabledReason:
                typeof entry.disabledReason === "string"
                  ? entry.disabledReason
                  : "This profile is disabled by managed Codex requirements.",
            }
          : {}),
      },
    ];
  });
  const nextCursor =
    typeof record.nextCursor === "string" && record.nextCursor.trim()
      ? record.nextCursor.trim()
      : undefined;
  return { profiles, nextCursor };
}

export async function listCodexPermissionProfiles(
  params: {
    proc?: CodexAppServerProcess;
    codexPath?: string;
    processKey?: string;
    cwd?: string;
  } = {},
): Promise<CodexPermissionProfileCatalog> {
  const proc =
    params.proc ??
    (await getOrCreateCodexAppServerProcess(
      params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
      { codexPath: resolveCodexAppServerBinaryPath(params.codexPath) },
    ));
  const cwd = params.cwd ?? resolveCodexNativeRuntimeCwd();
  if (
    typeof proc.isProtocolInitialized === "function" &&
    !proc.isProtocolInitialized()
  ) {
    return {
      kind: "legacy",
      profiles: [
        {
          id: ":read-only",
          description: "Legacy Codex read-only sandbox.",
          allowed: true,
        },
      ],
    };
  }
  const profiles: CodexPermissionProfile[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = normalizePage(
        await proc.sendRequest("permissionProfile/list", {
          ...(cwd ? { cwd } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const profile of page.profiles) {
        if (seen.has(profile.id)) continue;
        seen.add(profile.id);
        profiles.push(profile);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { kind: "profiles", profiles };
  } catch (error) {
    if (!isMethodNotFound(error)) throw error;
    return {
      kind: "legacy",
      profiles: [
        {
          id: ":read-only",
          description: "Legacy Codex read-only sandbox.",
          allowed: true,
        },
      ],
    };
  }
}

export function validateCodexPermissionSelection(params: {
  selectedId: string;
  catalog: CodexPermissionProfileCatalog;
}): void {
  if (params.catalog.kind === "legacy" && params.selectedId !== ":read-only") {
    throw new Error(
      "This Codex version supports only Read only (legacy). Update Codex or choose :read-only.",
    );
  }
  const selected = params.catalog.profiles.find(
    (profile) => profile.id === params.selectedId,
  );
  if (!selected?.allowed) {
    throw new Error(
      "Choose an allowed Codex permission profile before sending.",
    );
  }
}

export async function resolveCodexPermissionExecution(params: {
  proc: CodexAppServerProcess;
  cwd?: string;
}): Promise<{
  profileId: string;
  legacy: boolean;
  threadParams: { sandbox: "read-only" } | { permissions: string };
}> {
  const profileId = getCodexPermissionProfilePref();
  const catalog = await listCodexPermissionProfiles({
    proc: params.proc,
    cwd: params.cwd,
  });
  validateCodexPermissionSelection({ selectedId: profileId, catalog });
  const legacy = catalog.kind === "legacy";
  return {
    profileId,
    legacy,
    threadParams: legacy
      ? { sandbox: "read-only" }
      : { permissions: profileId },
  };
}
