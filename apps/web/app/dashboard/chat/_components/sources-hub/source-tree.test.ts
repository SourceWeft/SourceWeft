import { describe, expect, it } from "vitest";
import type { SourceItem } from "../source-types";
import {
  buildSourceSelectionStateMap,
  buildSourceTree,
  collectSelectableSourceIds,
  findNodePath,
  flattenVisibleSourceTree,
  normalizeSourceSelectionFromTree,
  toggleSourceSelectionInTree,
} from "./source-tree";

function source(input: Partial<SourceItem> & Pick<SourceItem, "id" | "title">) {
  return {
    contentText: "",
    meta: input.meta ?? "Updated today",
    parentSourceId: input.parentSourceId ?? null,
    sourceType: input.sourceType ?? "note",
    status: input.status ?? "Indexed",
    type: input.type ?? "TEXT",
    ...input,
  } satisfies SourceItem;
}

function treeIds(sources: SourceItem[], searchQuery = "") {
  return flattenVisibleSourceTree(buildSourceTree(sources, searchQuery), {
    autoExpand: true,
    expandedDirectoryIds: new Set(),
    userCollapsedDirectoryIds: new Set(),
  }).map((row) => row.node.source.id);
}

describe("source tree helpers", () => {
  it("builds a directory-first sorted tree", () => {
    const sources = [
      source({ id: "root-file", title: "Zeta note" }),
      source({ id: "folder-b", title: "Beta", sourceType: "directory", type: "DIR" }),
      source({ id: "folder-a", title: "Alpha", sourceType: "directory", type: "DIR" }),
      source({ id: "child-b", parentSourceId: "folder-a", title: "Beta child" }),
      source({ id: "child-a", parentSourceId: "folder-a", title: "Alpha child" }),
    ];

    expect(treeIds(sources)).toEqual([
      "folder-a",
      "child-a",
      "child-b",
      "folder-b",
      "root-file",
    ]);
  });

  it("keeps descendants visible when an ancestor matches search", () => {
    const sources = [
      source({ id: "projects", title: "Projects", sourceType: "directory", type: "DIR" }),
      source({ id: "notes", parentSourceId: "projects", title: "Unrelated child" }),
      source({ id: "other", title: "Other" }),
    ];

    expect(treeIds(sources, "projects")).toEqual(["projects", "notes"]);
  });

  it("marks parent folders indeterminate when only some children are selected", () => {
    const tree = buildSourceTree([
      source({ id: "folder", title: "Folder", sourceType: "directory", type: "DIR" }),
      source({ id: "a", parentSourceId: "folder", title: "A" }),
      source({ id: "b", parentSourceId: "folder", title: "B" }),
    ], "");

    const states = buildSourceSelectionStateMap(tree, new Set(["a"]));

    expect(states.get("folder")).toBe("indeterminate");
    expect(states.get("a")).toBe(true);
    expect(states.get("b")).toBe(false);
  });

  it("replaces a selected ancestor with sibling selections when a child is toggled off", () => {
    const tree = buildSourceTree([
      source({ id: "folder", title: "Folder", sourceType: "directory", type: "DIR" }),
      source({ id: "a", parentSourceId: "folder", title: "A" }),
      source({ id: "b", parentSourceId: "folder", title: "B" }),
    ], "");
    const childA = findNodePath(tree, "a")?.at(-1);

    expect(childA).toBeDefined();
    const toggled = toggleSourceSelectionInTree(tree, childA!, ["folder"]);

    expect(toggled).toEqual(["b"]);
  });

  it("normalizes explicit child selections into parent selections after tree changes", () => {
    const tree = buildSourceTree([
      source({ id: "folder", title: "Folder", sourceType: "directory", type: "DIR" }),
      source({ id: "a", parentSourceId: "folder", title: "A" }),
      source({ id: "b", parentSourceId: "folder", title: "B" }),
    ], "");

    expect(normalizeSourceSelectionFromTree(tree, ["a", "b"])).toEqual([
      "folder",
    ]);
  });

  it("excludes failed and syncing sources from selectable ids", () => {
    const tree = buildSourceTree([
      source({ id: "folder", title: "Folder", sourceType: "directory", type: "DIR" }),
      source({ id: "ready", parentSourceId: "folder", title: "Ready" }),
      source({
        id: "failed",
        parentSourceId: "folder",
        status: "Failed",
        title: "Failed",
      }),
      source({
        id: "syncing",
        parentSourceId: "folder",
        status: "Syncing",
        title: "Syncing",
      }),
    ], "");

    expect(collectSelectableSourceIds(tree)).toEqual(["folder", "ready"]);
  });
});
