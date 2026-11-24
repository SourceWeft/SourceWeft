import {
  STUDY_LIMITS,
  studyFingerprint,
  type MindmapNode,
  type StudyEvidence,
} from "@sourceweft/contracts/study";
import { ngramJaccard } from "./dedupe";
import type { DropCounts, MindmapGroupCandidate } from "./types";
import { addDrop, type StudyIdAllocator } from "./validate";

/** A node while the tree is still being shaped. */
export type WorkNode = {
  id: string;
  fingerprint: string;
  label: string;
  summary: string | null;
  refs: string[];
  evidence: StudyEvidence[];
  children: WorkNode[];
  /** Built by the engine to hold groups (root, branches, buckets), not by the model. */
  structural?: boolean;
};

/** Turns one group's flat node list into a forest under the group's root. */
export function buildGroupForest(tree: MindmapGroupCandidate): WorkNode[] {
  const byKey = new Map<string, WorkNode>();
  const roots: WorkNode[] = [];
  for (const node of tree.nodes) {
    const work: WorkNode = {
      id: node.id,
      fingerprint: node.fingerprint,
      label: node.label,
      summary: node.summary,
      refs: node.refs,
      evidence: [],
      children: [],
    };
    byKey.set(node.key, work);
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined;
    if (parent) parent.children.push(work);
    else roots.push(work);
  }
  return roots;
}

function subtreeSize(node: WorkNode): number {
  return 1 + node.children.reduce((sum, child) => sum + subtreeSize(child), 0);
}

/**
 * Applies per-node verdicts bottom-up. A node without evidence survives only
 * as a category over surviving children; a node in the wrong language is
 * removed and its children move up to its parent.
 */
export function pruneForest(
  nodes: WorkNode[],
  verdict: (node: WorkNode) => "keep" | "unanchored" | "wrongLanguage",
  dropped: DropCounts,
): WorkNode[] {
  const result: WorkNode[] = [];
  for (const node of nodes) {
    node.children = pruneForest(node.children, verdict, dropped);
    const outcome = verdict(node);
    if (outcome === "keep") {
      result.push(node);
    } else if (outcome === "wrongLanguage") {
      addDrop(dropped, "wrongLanguage");
      result.push(...node.children);
    } else if (node.children.length > 0) {
      node.evidence = [];
      result.push(node);
    } else {
      addDrop(dropped, "unanchored");
    }
  }
  return result;
}

/** Siblings with near-identical labels merge into the first one. */
export function mergeDuplicateSiblings(
  nodes: WorkNode[],
  dropped: DropCounts,
): WorkNode[] {
  const result: WorkNode[] = [];
  for (const node of nodes) {
    const twin = result.find(
      (existing) => ngramJaccard(existing.label, node.label) >= 0.8,
    );
    if (twin) {
      addDrop(dropped, "duplicate");
      twin.children.push(...node.children);
      if (twin.evidence.length === 0) twin.evidence = node.evidence;
    } else {
      result.push(node);
    }
  }
  for (const node of result) {
    node.children = mergeDuplicateSiblings(node.children, dropped);
  }
  return result;
}

function groupNode(
  label: string,
  summary: string | null,
  children: WorkNode[],
  ids: StudyIdAllocator,
): WorkNode {
  const fingerprint = studyFingerprint("mindmap", label);
  return {
    id: ids.allocate(fingerprint),
    fingerprint,
    label,
    summary,
    refs: [],
    evidence: [],
    children,
    structural: true,
  };
}

/**
 * Levels below the mind map root that one group's own nodes may use: with
 * several groups each becomes a branch (one level), and past the fan-out a
 * bucket level is added above the branches.
 */
export function groupNodeDepth(groupCount: number): number {
  if (groupCount <= 1) return STUDY_LIMITS.mindmapMaxDepth;
  if (groupCount <= STUDY_LIMITS.mindmapMaxFanout) {
    return STUDY_LIMITS.mindmapMaxDepth - 1;
  }
  return STUDY_LIMITS.mindmapMaxDepth - 2;
}

/**
 * Joins group forests under one root. One group: its own root. Several: one
 * branch per group; past the fan-out the branches are bucketed in order.
 */
export function assembleRoot(input: {
  groups: { tree: MindmapGroupCandidate; forest: WorkNode[] }[];
  rootLabel: string;
  ids: StudyIdAllocator;
}): WorkNode {
  const { groups, ids } = input;
  if (groups.length === 1) {
    const only = groups[0]!;
    return groupNode(
      only.tree.rootLabel || input.rootLabel,
      only.tree.rootSummary,
      only.forest,
      ids,
    );
  }
  const branches = groups
    .filter((group) => group.forest.length > 0)
    .map((group) =>
      groupNode(
        group.tree.rootLabel || input.rootLabel,
        group.tree.rootSummary,
        group.forest,
        ids,
      ),
    );
  const fanout = STUDY_LIMITS.mindmapMaxFanout;
  if (branches.length <= fanout) {
    return groupNode(truncateLabel(input.rootLabel), null, branches, ids);
  }
  const perBucket = Math.ceil(branches.length / fanout);
  const buckets: WorkNode[] = [];
  for (let start = 0; start < branches.length; start += perBucket) {
    const members = branches.slice(start, start + perBucket);
    const label =
      members.length === 1
        ? members[0]!.label
        : truncateLabel(`${members[0]!.label} / ${members[members.length - 1]!.label}`);
    buckets.push(groupNode(label, null, members, ids));
  }
  return groupNode(truncateLabel(input.rootLabel), null, buckets, ids);
}

function truncateLabel(label: string) {
  const chars = [...label];
  const max = STUDY_LIMITS.mindmapLabelChars;
  return chars.length <= max ? label : chars.slice(0, max - 1).join("") + "…";
}

/**
 * Drops levels past the depth limit and, past the fan-out, keeps the children
 * with the most beneath them (in their original order), so a wide level loses
 * as little of the map as it can.
 */
function limitShape(node: WorkNode, depth: number, dropped: DropCounts): void {
  if (depth + 1 > STUDY_LIMITS.mindmapMaxDepth) {
    for (const child of node.children) addDrop(dropped, "depth", subtreeSize(child));
    node.children = [];
    return;
  }
  const fanout = STUDY_LIMITS.mindmapMaxFanout;
  if (node.children.length > fanout) {
    const largest = new Set(
      node.children
        .map((child, index) => ({ child, index, size: subtreeSize(child) }))
        .sort((a, b) => b.size - a.size || a.index - b.index)
        .slice(0, fanout)
        .map(({ child }) => child),
    );
    for (const child of node.children) {
      if (!largest.has(child)) addDrop(dropped, "fanout", subtreeSize(child));
    }
    node.children = node.children.filter((child) => largest.has(child));
  }
  for (const child of node.children) limitShape(child, depth + 1, dropped);
}

/**
 * The model's nodes, one breadth-first list per group: the content under
 * each structural node, parents before their children.
 */
function contentUnits(root: WorkNode): WorkNode[][] {
  const units: WorkNode[][] = [];
  const visit = (holder: WorkNode) => {
    const unit: WorkNode[] = [];
    const queue = holder.children.filter((child) => !child.structural);
    while (queue.length > 0) {
      const node = queue.shift()!;
      unit.push(node);
      queue.push(...node.children);
    }
    if (unit.length > 0) units.push(unit);
    for (const child of holder.children) if (child.structural) visit(child);
  };
  visit(root);
  return units;
}

function structuralBelow(node: WorkNode): number {
  return node.children.reduce(
    (sum, child) => sum + (child.structural ? 1 + structuralBelow(child) : 0),
    0,
  );
}

/**
 * Enforces depth, fan-out and node count, then removes categories that lost
 * every child. The count limits the model's nodes, not the branches that
 * hold groups, and is shared round-robin: every group keeps a node before any
 * keeps a second, and within a group parents come before children. Returns
 * the number of the model's nodes kept.
 */
export function enforceMindmapLimits(
  root: WorkNode,
  maxNodesBelowRoot: number,
  dropped: DropCounts,
): number {
  limitShape(root, 0, dropped);
  const budget = Math.max(
    0,
    Math.min(maxNodesBelowRoot, STUDY_LIMITS.mindmapMaxNodes - 1 - structuralBelow(root)),
  );
  const units = contentUnits(root);
  const keep = new Set<WorkNode>();
  for (let round = 0; keep.size < budget; round += 1) {
    let added = false;
    for (const unit of units) {
      const node = unit[round];
      if (!node || keep.size >= budget) continue;
      keep.add(node);
      added = true;
    }
    if (!added) break;
  }

  let kept = keep.size;
  const trim = (node: WorkNode): void => {
    node.children = node.children.filter((child) => {
      if (!child.structural && !keep.has(child)) {
        addDrop(dropped, "surplus", subtreeSize(child));
        return false;
      }
      trim(child);
      return true;
    });
  };
  trim(root);

  const removeEmptyCategories = (node: WorkNode): void => {
    node.children = node.children.filter((child) => {
      removeEmptyCategories(child);
      if (child.children.length > 0 || child.evidence.length > 0) return true;
      if (!child.structural) {
        kept -= 1;
        addDrop(dropped, "unanchored");
      }
      return false;
    });
  };
  removeEmptyCategories(root);
  return kept;
}

export function toMindmapNode(node: WorkNode): MindmapNode {
  return {
    id: node.id,
    fingerprint: node.fingerprint,
    label: node.label,
    summary: node.summary,
    children: node.children.map(toMindmapNode),
    evidence: node.evidence,
  };
}
