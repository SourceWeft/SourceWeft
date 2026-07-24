const MCP_SELECTION_STORAGE_PREFIX = "chat:mcp";

export type StoredMcpSelection = {
  installIds: string[];
  toolIds: string[];
};

function parseIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function keyFor(workspaceId: string, bucket: string) {
  return `${MCP_SELECTION_STORAGE_PREFIX}:${workspaceId}:${bucket}`;
}

/**
 * Per-(workspace, thread) MCP selection. Unlike a plain module-level state, this
 * is keyed by thread so navigating between threads (which the App Router does
 * WITHOUT remounting the thread page) never carries one thread's selected MCP
 * servers into another. Mirrors source-selection-storage.
 */
export function readStoredMcpSelection(
  workspaceId: string,
  bucket: string,
): StoredMcpSelection {
  const key = keyFor(workspaceId, bucket);
  const raw =
    window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
  if (!raw) {
    return { installIds: [], toolIds: [] };
  }
  try {
    const parsed = JSON.parse(raw) as {
      installIds?: unknown;
      toolIds?: unknown;
    };
    return {
      installIds: parseIds(parsed.installIds),
      toolIds: parseIds(parsed.toolIds),
    };
  } catch {
    return { installIds: [], toolIds: [] };
  }
}

export function writeStoredMcpSelection(
  workspaceId: string,
  bucket: string,
  selection: StoredMcpSelection,
) {
  window.localStorage.setItem(
    keyFor(workspaceId, bucket),
    JSON.stringify(selection),
  );
}

export function clearStoredMcpSelection(workspaceId: string, bucket: string) {
  const key = keyFor(workspaceId, bucket);
  window.localStorage.removeItem(key);
  window.sessionStorage.removeItem(key);
}
