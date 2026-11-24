import type { MindmapNode } from "@sourceweft/contracts/study";

/** Horizontal distance between two tree levels, node width included. */
export const MINDMAP_COLUMN_WIDTH = 240;
/** Vertical distance between two neighbouring leaves, node height included. */
export const MINDMAP_ROW_HEIGHT = 64;

export type MindmapLayoutNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  /** Children in the data, whether shown or not. */
  readonly childCount: number;
  readonly collapsed: boolean;
  readonly node: MindmapNode;
};

export type MindmapLayoutEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
};

export type MindmapLayout = {
  readonly nodes: MindmapLayoutNode[];
  readonly edges: MindmapLayoutEdge[];
};

export type LayoutTreeOptions = {
  /** Nodes whose descendants are hidden. */
  readonly collapsed?: ReadonlySet<string>;
};

/**
 * A left-to-right tidy tree: each level is a column, every visible leaf gets
 * its own row, and a parent sits halfway between its first and last child.
 * Because a subtree's leaves are consecutive rows, two nodes never share a
 * column and a row, so no two nodes overlap.
 *
 * Iterative (explicit stack), so an unexpectedly deep tree cannot overflow the
 * call stack.
 */
export function layoutTree(
  root: MindmapNode,
  options: LayoutTreeOptions = {},
): MindmapLayout {
  const collapsed = options.collapsed ?? new Set<string>();
  const nodes: MindmapLayoutNode[] = [];
  const edges: MindmapLayoutEdge[] = [];
  const rows = new Map<string, number>();
  let nextLeafRow = 0;

  type Frame = { node: MindmapNode; depth: number; visited: boolean };
  const stack: Frame[] = [{ node: root, depth: 0, visited: false }];
  const order: Frame[] = [];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const shownChildren = collapsed.has(frame.node.id)
      ? []
      : frame.node.children;
    if (frame.visited || shownChildren.length === 0) {
      // Post-order: every child already has its row.
      const row =
        shownChildren.length === 0
          ? nextLeafRow++
          : (rows.get(shownChildren[0]!.id)! +
              rows.get(shownChildren[shownChildren.length - 1]!.id)!) /
            2;
      rows.set(frame.node.id, row);
      order.push(frame);
      continue;
    }
    stack.push({ ...frame, visited: true });
    for (let i = shownChildren.length - 1; i >= 0; i -= 1) {
      const child = shownChildren[i]!;
      stack.push({ node: child, depth: frame.depth + 1, visited: false });
      edges.push({
        id: `${frame.node.id}->${child.id}`,
        source: frame.node.id,
        target: child.id,
      });
    }
  }

  // Report nodes in pre-order (parent before children), the reading order.
  const byId = new Map(order.map((frame) => [frame.node.id, frame]));
  const walk = [root];
  for (let node = walk.pop(); node; node = walk.pop()) {
    const frame = byId.get(node.id);
    if (!frame) continue;
    nodes.push({
      id: node.id,
      x: frame.depth * MINDMAP_COLUMN_WIDTH,
      y: rows.get(node.id)! * MINDMAP_ROW_HEIGHT,
      depth: frame.depth,
      childCount: node.children.length,
      collapsed: collapsed.has(node.id) && node.children.length > 0,
      node,
    });
    if (!collapsed.has(node.id)) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        walk.push(node.children[i]!);
      }
    }
  }
  edges.reverse();
  return { nodes, edges };
}

/** Ids of every node at `depth` that has children: collapsing them shows `depth` levels below the root. */
export function nodesWithChildrenAtDepth(
  root: MindmapNode,
  depth: number,
): Set<string> {
  const result = new Set<string>();
  const stack: { node: MindmapNode; depth: number }[] = [{ node: root, depth: 0 }];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    if (entry.depth === depth) {
      if (entry.node.children.length > 0) result.add(entry.node.id);
      continue;
    }
    for (const child of entry.node.children) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return result;
}
