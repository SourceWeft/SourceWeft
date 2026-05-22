export type HubTabStorageValue = string;

export function createHubTabStorage<Tab extends HubTabStorageValue>(input: {
  allowedTabs: readonly Tab[];
  defaultTab: Tab;
  storageKey: string;
}) {
  const allowed = new Set<string>(input.allowedTabs);
  let lastHubActiveTab = input.defaultTab;

  return {
    getLastHubActiveTab() {
      return lastHubActiveTab;
    },
    readStoredHubTab() {
      if (typeof window === "undefined") {
        return null;
      }

      try {
        const value = window.sessionStorage.getItem(input.storageKey);
        return value && allowed.has(value) ? (value as Tab) : null;
      } catch {
        return null;
      }
    },
    persistHubTab(tab: Tab) {
      lastHubActiveTab = tab;

      if (typeof window === "undefined") {
        return;
      }

      try {
        window.sessionStorage.setItem(input.storageKey, tab);
      } catch {
        // Ignore storage failures; the in-memory tab state still works.
      }
    },
  };
}

export function getSourceTreeExpansionStorageKey(
  storagePrefix: string,
  workspaceId?: string | null,
) {
  return workspaceId ? `${storagePrefix}:${workspaceId}` : null;
}

export function readStoredSourceTreeExpansion(
  storagePrefix: string,
  workspaceId?: string | null,
) {
  const key = getSourceTreeExpansionStorageKey(storagePrefix, workspaceId);
  if (!key || typeof window === "undefined") {
    return {
      expandedDirectoryIds: new Set<string>(),
      userCollapsedDirectoryIds: new Set<string>(),
    };
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {
        expandedDirectoryIds: new Set<string>(),
        userCollapsedDirectoryIds: new Set<string>(),
      };
    }
    const parsed = JSON.parse(raw) as {
      expandedDirectoryIds?: unknown;
      userCollapsedDirectoryIds?: unknown;
    };
    const expanded = Array.isArray(parsed.expandedDirectoryIds)
      ? parsed.expandedDirectoryIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const collapsed = Array.isArray(parsed.userCollapsedDirectoryIds)
      ? parsed.userCollapsedDirectoryIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      expandedDirectoryIds: new Set(expanded),
      userCollapsedDirectoryIds: new Set(collapsed),
    };
  } catch {
    return {
      expandedDirectoryIds: new Set<string>(),
      userCollapsedDirectoryIds: new Set<string>(),
    };
  }
}

export function persistSourceTreeExpansion(input: {
  storagePrefix: string;
  workspaceId?: string | null;
  expandedDirectoryIds: Set<string>;
  userCollapsedDirectoryIds: Set<string>;
}) {
  const key = getSourceTreeExpansionStorageKey(
    input.storagePrefix,
    input.workspaceId,
  );
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        expandedDirectoryIds: Array.from(input.expandedDirectoryIds),
        userCollapsedDirectoryIds: Array.from(input.userCollapsedDirectoryIds),
      }),
    );
  } catch {
    // Ignore storage failures; the current in-memory tree state still works.
  }
}
