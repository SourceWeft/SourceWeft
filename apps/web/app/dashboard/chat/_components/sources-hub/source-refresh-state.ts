import type { SourceItem } from "../source-types";

export type WorkspaceSourceHydrationDecision =
  | {
      kind: "clear";
      initializedWorkspaceId: null;
      sources: SourceItem[];
    }
  | {
      kind: "skip";
      initializedWorkspaceId: string;
      sources: null;
    }
  | {
      kind: "hydrate";
      initializedWorkspaceId: string;
      sources: SourceItem[];
    };

export function resolveWorkspaceSourceHydration({
  initializedWorkspaceId,
  initialSources,
  initialSourcesLoaded,
  workspaceId,
}: {
  initializedWorkspaceId: string | null;
  initialSources: SourceItem[];
  initialSourcesLoaded: boolean;
  workspaceId: string | null | undefined;
}): WorkspaceSourceHydrationDecision {
  if (!workspaceId) {
    return {
      kind: "clear",
      initializedWorkspaceId: null,
      sources: [],
    };
  }

  if (initializedWorkspaceId === workspaceId) {
    return {
      kind: "skip",
      initializedWorkspaceId: workspaceId,
      sources: null,
    };
  }

  return {
    kind: "hydrate",
    initializedWorkspaceId: workspaceId,
    sources: initialSourcesLoaded ? initialSources : [],
  };
}
