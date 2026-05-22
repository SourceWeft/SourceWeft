import type { SourceItem } from "../source-types";

export type SourceTreeNode = {
  source: SourceItem;
  children: SourceTreeNode[];
};

export type SourceTreeIndex = {
  byParent: Map<string | null, SourceItem[]>;
};

export type SourceSelectionState = boolean | "indeterminate";

export type FlattenedSourceTreeRow = {
  node: SourceTreeNode;
  depth: number;
};

export type SourceTreeMatcher = (source: SourceItem, query: string) => boolean;

export function defaultSourceMatchesQuery(source: SourceItem, query: string) {
  return (
    source.title.toLowerCase().includes(query) ||
    source.type.toLowerCase().includes(query) ||
    source.status.toLowerCase().includes(query) ||
    source.meta.toLowerCase().includes(query)
  );
}

export function buildSourceTreeIndex(sources: SourceItem[]): SourceTreeIndex {
  const byParent = new Map<string | null, SourceItem[]>();

  for (const source of sources) {
    const parentId = source.parentSourceId ?? null;
    const items = byParent.get(parentId) ?? [];
    items.push(source);
    byParent.set(parentId, items);
  }

  for (const items of byParent.values()) {
    items.sort((a, b) => {
      if (a.sourceType === "directory" && b.sourceType !== "directory") {
        return -1;
      }
      if (a.sourceType !== "directory" && b.sourceType === "directory") {
        return 1;
      }
      return a.title.localeCompare(b.title);
    });
  }

  return { byParent };
}

export function buildSourceTreeFromIndex(
  index: SourceTreeIndex,
  searchQuery: string,
  matchesQuery: SourceTreeMatcher = defaultSourceMatchesQuery,
) {
  const query = searchQuery.trim().toLowerCase();

  function build(
    parentId: string | null,
    ancestorsMatch = false,
  ): SourceTreeNode[] {
    return (index.byParent.get(parentId) ?? [])
      .map((source) => {
        const selfMatch = !query || matchesQuery(source, query);
        const children = build(source.id, ancestorsMatch || selfMatch);
        if (query && !selfMatch && children.length === 0 && !ancestorsMatch) {
          return null;
        }
        return { source, children } satisfies SourceTreeNode;
      })
      .filter((node): node is SourceTreeNode => node !== null);
  }

  return build(null);
}

export function buildSourceTree(
  sources: SourceItem[],
  searchQuery: string,
  matchesQuery: SourceTreeMatcher = defaultSourceMatchesQuery,
) {
  return buildSourceTreeFromIndex(
    buildSourceTreeIndex(sources),
    searchQuery,
    matchesQuery,
  );
}

export function countTreeNodes(nodes: SourceTreeNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + 1 + countTreeNodes(node.children),
    0,
  );
}

export function collectTreeIds(node: SourceTreeNode): string[] {
  return [
    node.source.id,
    ...node.children.flatMap((child) => collectTreeIds(child)),
  ];
}

export function isSelectableSource(source: SourceItem) {
  return source.status !== "Failed" && source.status !== "Syncing";
}

export function isSyncingSource(source: SourceItem) {
  return source.status === "Syncing";
}

export function collectSelectableTreeIds(node: SourceTreeNode): string[] {
  return [
    ...(isSelectableSource(node.source) ? [node.source.id] : []),
    ...node.children.flatMap((child) => collectSelectableTreeIds(child)),
  ];
}

export function collectSelectableSourceIds(nodes: SourceTreeNode[]) {
  return nodes.flatMap((node) => collectSelectableTreeIds(node));
}

export function getNodeSelectionState(
  node: SourceTreeNode,
  selectedSet: Set<string>,
  ancestorSelected = false,
): SourceSelectionState {
  if (!isSelectableSource(node.source)) {
    return false;
  }

  if (ancestorSelected || selectedSet.has(node.source.id)) {
    return true;
  }

  if (node.children.length === 0) {
    return false;
  }

  const childStates = node.children.map((child) =>
    getNodeSelectionState(child, selectedSet),
  );
  if (childStates.every((state) => state === true)) {
    return true;
  }
  if (childStates.some((state) => state !== false)) {
    return "indeterminate";
  }
  return false;
}

export function buildSourceSelectionStateMap(
  nodes: SourceTreeNode[],
  selectedSet: Set<string>,
) {
  const selectionStateById = new Map<string, SourceSelectionState>();

  function visit(
    node: SourceTreeNode,
    ancestorSelected = false,
  ): SourceSelectionState {
    const selectedByAncestorOrSelf =
      ancestorSelected || selectedSet.has(node.source.id);

    if (!isSelectableSource(node.source)) {
      selectionStateById.set(node.source.id, false);
      node.children.forEach((child) => visit(child, selectedByAncestorOrSelf));
      return false;
    }

    if (selectedByAncestorOrSelf) {
      selectionStateById.set(node.source.id, true);
      node.children.forEach((child) => visit(child, true));
      return true;
    }

    if (node.children.length === 0) {
      selectionStateById.set(node.source.id, false);
      return false;
    }

    const childStates = node.children.map((child) => visit(child, false));
    const selectionState = childStates.every((state) => state === true)
      ? true
      : childStates.some((state) => state !== false)
        ? "indeterminate"
        : false;
    selectionStateById.set(node.source.id, selectionState);
    return selectionState;
  }

  nodes.forEach((node) => visit(node));
  return selectionStateById;
}

export function flattenVisibleSourceTree(
  nodes: SourceTreeNode[],
  input: {
    autoExpand: boolean;
    expandedDirectoryIds: Set<string>;
    userCollapsedDirectoryIds: Set<string>;
  },
) {
  const rows: FlattenedSourceTreeRow[] = [];

  function visit(node: SourceTreeNode, depth: number) {
    rows.push({ node, depth });
    const source = node.source;
    const open =
      input.autoExpand ||
      (source.sourceType === "directory" &&
        input.expandedDirectoryIds.has(source.id) &&
        !input.userCollapsedDirectoryIds.has(source.id));
    if (open) {
      node.children.forEach((child) => visit(child, depth + 1));
    }
  }

  nodes.forEach((node) => visit(node, 0));
  return rows;
}

export function findNodePath(
  nodes: SourceTreeNode[],
  sourceId: string,
): SourceTreeNode[] | null {
  for (const node of nodes) {
    if (node.source.id === sourceId) {
      return [node];
    }

    const childPath = findNodePath(node.children, sourceId);
    if (childPath) {
      return [node, ...childPath];
    }
  }

  return null;
}

export function subtreeContainsSource(
  node: SourceTreeNode,
  sourceId: string,
): boolean {
  return (
    node.source.id === sourceId ||
    node.children.some((child) => subtreeContainsSource(child, sourceId))
  );
}

export function selectSubtreeExcept(
  node: SourceTreeNode,
  excludedNode: SourceTreeNode,
): string[] {
  if (node.source.id === excludedNode.source.id) {
    return [];
  }

  if (!isSelectableSource(node.source)) {
    return [];
  }

  const childWithExcludedNode = node.children.find((child) =>
    subtreeContainsSource(child, excludedNode.source.id),
  );
  if (!childWithExcludedNode) {
    return [node.source.id];
  }

  return node.children.flatMap((child) =>
    child.source.id === childWithExcludedNode.source.id
      ? selectSubtreeExcept(child, excludedNode)
      : collectSelectableTreeIds(child),
  );
}

export function normalizeSourceSelectionFromTree(
  nodes: SourceTreeNode[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);

  function normalizeNode(node: SourceTreeNode): string[] {
    if (!isSelectableSource(node.source)) {
      return [];
    }

    if (selectedSet.has(node.source.id)) {
      return [node.source.id];
    }

    if (node.children.length === 0) {
      return [];
    }

    const childIds = node.children.flatMap(normalizeNode);
    const allChildrenSelected = node.children.every(
      (child) => getNodeSelectionState(child, selectedSet) === true,
    );

    if (!allChildrenSelected) {
      return childIds;
    }

    return [node.source.id];
  }

  return nodes.flatMap(normalizeNode);
}

export function toggleSourceSelectionInTree(
  fullTree: SourceTreeNode[],
  node: SourceTreeNode,
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);
  if (!isSelectableSource(node.source)) {
    return selectedIds.filter((id) => id !== node.source.id);
  }

  const nodePath = findNodePath(fullTree, node.source.id) ?? [node];
  const selectedAncestor = [...nodePath]
    .slice(0, -1)
    .reverse()
    .find((ancestor) => selectedSet.has(ancestor.source.id));
  const nodeState = getNodeSelectionState(
    node,
    selectedSet,
    Boolean(selectedAncestor),
  );
  const idsToRemove = new Set(collectSelectableTreeIds(node));

  if (nodeState === true) {
    if (selectedAncestor) {
      const replacementIds = selectSubtreeExcept(selectedAncestor, node);
      return [
        ...selectedIds.filter((id) => id !== selectedAncestor.source.id),
        ...replacementIds,
      ];
    }

    return selectedIds.filter((id) => !idsToRemove.has(id));
  }

  const next = selectedIds.filter((id) => !idsToRemove.has(id));
  const selectableIds = collectSelectableTreeIds(node);
  if (selectableIds.length === 0) {
    return next;
  }
  return [...next, node.source.id];
}
