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
 * Enforces depth, fan-out and node count (breadth first, so parents are kept
 * before their children), then removes categories that lost every child.
 * Returns the number of nodes kept below the root.
 */
export function enforceMindmapLimits(
  root: WorkNode,
  maxNodesBelowRoot: number,
  dropped: DropCounts,
): number {
  const budget = Math.min(maxNodesBelowRoot, STUDY_LIMITS.mindmapMaxNodes - 1);
  let kept = 0;
  const queue: { node: WorkNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    const children: WorkNode[] = [];
    for (const [index, child] of node.children.entries()) {
      if (depth + 1 > STUDY_LIMITS.mindmapMaxDepth) {
        addDrop(dropped, "depth", subtreeSize(child));
      } else if (index >= STUDY_LIMITS.mindmapMaxFanout) {
        addDrop(dropped, "fanout", subtreeSize(child));
      } else if (kept >= budget) {
        addDrop(dropped, "surplus", subtreeSize(child));
      } else {
        kept += 1;
        children.push(child);
        queue.push({ node: child, depth: depth + 1 });
      }
    }
    node.children = children;
  }
  const removeEmptyCategories = (node: WorkNode): void => {
    node.children = node.children.filter((child) => {
      removeEmptyCategories(child);
      if (child.children.length === 0 && child.evidence.length === 0) {
        kept -= 1;
        addDrop(dropped, "unanchored");
        return false;
      }
      return true;
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
