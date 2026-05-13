import type { SourceItem } from "./source-types";

const workspaceSourcesCache = new Map<string, SourceItem[]>();

function cloneSources(sources: SourceItem[]) {
  return sources.map((source) => ({ ...source }));
}

export function getCachedWorkspaceSources(
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return null;
  }

  const cached = workspaceSourcesCache.get(workspaceId);
  return cached ? cloneSources(cached) : null;
}

export function hasCachedWorkspaceSources(
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return false;
  }

  return workspaceSourcesCache.has(workspaceId);
}

export function setCachedWorkspaceSources(
  workspaceId: string | null | undefined,
  sources: SourceItem[],
) {
  if (!workspaceId) {
    return;
  }

  workspaceSourcesCache.set(workspaceId, cloneSources(sources));
}
