const STORAGE_KEY = "sourceweft.dashboard.workspace-context.v1";

type StoredWorkspaceContext = Record<string, string>;

function readContext(): StoredWorkspaceContext {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeContext(context: StoredWorkspaceContext) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Storage can be unavailable in private browsing or restricted contexts.
  }
}

export function getStoredDashboardWorkspaceId(teamId?: string | null) {
  if (!teamId) {
    return null;
  }

  return readContext()[teamId] ?? null;
}

export function setStoredDashboardWorkspaceId(
  teamId: string | null | undefined,
  workspaceId: string | null | undefined,
) {
  if (!teamId || !workspaceId) {
    return;
  }

  writeContext({
    ...readContext(),
    [teamId]: workspaceId,
  });
}
