import assert from "node:assert/strict";
import { test } from "node:test";
import { studyFingerprint, type MindmapNode } from "@sourceweft/contracts/study";
import {
  MINDMAP_COLUMN_WIDTH,
  MINDMAP_ROW_HEIGHT,
  layoutTree,
} from "../src/ui/mindmap/tree-layout";
import { mindmapFixtureEn } from "../src/testing/fixtures";

function boxesOverlap(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return (
    Math.abs(a.x - b.x) < MINDMAP_COLUMN_WIDTH &&
    Math.abs(a.y - b.y) < MINDMAP_ROW_HEIGHT
  );
}

function wideTree(depth: number, fanout: number, prefix = "n"): MindmapNode {
  return {
    id: prefix,
    fingerprint: studyFingerprint("mindmap", prefix),
    label: prefix,
    evidence: [],
    children:
      depth === 0
        ? []
        : Array.from({ length: fanout }, (_, i) =>
            wideTree(depth - 1, fanout, `${prefix}_${i}`),
          ),
  };
}

test("layout places every node once and no two nodes overlap", () => {
  const layout = layoutTree(mindmapFixtureEn.root);
  assert.equal(layout.nodes.length, 11);
  assert.equal(new Set(layout.nodes.map((node) => node.id)).size, 11);
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      assert.equal(
        boxesOverlap(layout.nodes[i]!, layout.nodes[j]!),
        false,
        `${layout.nodes[i]!.id} overlaps ${layout.nodes[j]!.id}`,
      );
    }
  }
});

test("layout grows to the right one column per level and links parent to child", () => {
  const layout = layoutTree(mindmapFixtureEn.root);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("n_root")!.x, 0);
  assert.equal(byId.get("n_inputs")!.x, MINDMAP_COLUMN_WIDTH);
  assert.equal(byId.get("n_starch")!.x, MINDMAP_COLUMN_WIDTH * 3);
  assert.equal(layout.edges.length, layout.nodes.length - 1);
  assert.ok(
    layout.edges.some(
      (edge) => edge.source === "n_glucose" && edge.target === "n_starch",
    ),
  );
  // A parent sits between its first and last child.
  const inputs = byId.get("n_inputs")!;
  assert.ok(inputs.y >= byId.get("n_water")!.y && inputs.y <= byId.get("n_light")!.y);
});

test("a collapsed node keeps its place but hides every descendant", () => {
  const layout = layoutTree(mindmapFixtureEn.root, {
    collapsed: new Set(["n_outputs"]),
  });
  const ids = layout.nodes.map((node) => node.id);
  assert.ok(ids.includes("n_outputs"));
  assert.ok(!ids.includes("n_glucose"));
  assert.ok(!ids.includes("n_starch"));
  assert.ok(!ids.includes("n_oxygen"));
  const outputs = layout.nodes.find((node) => node.id === "n_outputs")!;
  assert.equal(outputs.collapsed, true);
  assert.equal(outputs.childCount, 2);
  assert.ok(layout.edges.every((edge) => ids.includes(edge.target)));
});

test("layout handles the depth and fan-out limits and beyond without throwing", () => {
  const limit = layoutTree(wideTree(4, 8));
  assert.equal(limit.nodes.length, 1 + 8 + 64 + 512 + 4096);
  const deep = layoutTree(wideTree(200, 1));
  assert.equal(deep.nodes.length, 201);
  const single = layoutTree(wideTree(0, 0));
  assert.deepEqual(
    single.nodes.map((node) => [node.id, node.x, node.y]),
    [["n", 0, 0]],
  );
});
