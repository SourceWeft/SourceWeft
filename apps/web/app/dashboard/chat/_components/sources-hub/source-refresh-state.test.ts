import { describe, expect, it } from "vitest";
import type { SourceItem } from "../source-types";
import { resolveWorkspaceSourceHydration } from "./source-refresh-state";

function source(id: string): SourceItem {
  return {
    contentText: "",
    id,
    meta: "Updated today",
    parentSourceId: null,
    sourceType: "note",
    status: "Indexed",
    title: id,
    type: "TEXT",
  } satisfies SourceItem;
}

describe("resolveWorkspaceSourceHydration", () => {
  it("preserves existing sources during same-workspace refresh", () => {
    expect(
      resolveWorkspaceSourceHydration({
        initializedWorkspaceId: "workspace-1",
        initialSources: [],
        initialSourcesLoaded: false,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      kind: "skip",
      initializedWorkspaceId: "workspace-1",
      sources: null,
    });
  });

  it("clears sources only when workspace becomes unavailable", () => {
    expect(
      resolveWorkspaceSourceHydration({
        initializedWorkspaceId: "workspace-1",
        initialSources: [source("cached")],
        initialSourcesLoaded: true,
        workspaceId: null,
      }),
    ).toEqual({
      kind: "clear",
      initializedWorkspaceId: null,
      sources: [],
    });
  });

  it("hydrates cached sources immediately when initialSourcesLoaded is true", () => {
    const cachedSources = [source("cached-a"), source("cached-b")];

    expect(
      resolveWorkspaceSourceHydration({
        initializedWorkspaceId: null,
        initialSources: cachedSources,
        initialSourcesLoaded: true,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      kind: "hydrate",
      initializedWorkspaceId: "workspace-1",
      sources: cachedSources,
    });
  });

  it("does not reset workspace source hydration for thread-only changes", () => {
    const beforeThreadSwitch = resolveWorkspaceSourceHydration({
      initializedWorkspaceId: null,
      initialSources: [source("cached")],
      initialSourcesLoaded: true,
      workspaceId: "workspace-1",
    });

    expect(beforeThreadSwitch.initializedWorkspaceId).toBe("workspace-1");
    expect(
      resolveWorkspaceSourceHydration({
        initializedWorkspaceId: beforeThreadSwitch.initializedWorkspaceId,
        initialSources: [],
        initialSourcesLoaded: false,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      kind: "skip",
      initializedWorkspaceId: "workspace-1",
      sources: null,
    });
  });
});
