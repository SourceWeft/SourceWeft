import assert from "node:assert/strict";
import test from "node:test";
import { STUDY_LIMITS, studyContentSchema, type MindmapNode } from "@sourceweft/contracts/study";
import { generateStudyContent } from "../src/engine/generate";
import { baseInput, factAnchor, factChunks, promptHandles, stubModel } from "./fixtures";

function walk(node: MindmapNode, depth = 0, out: { depth: number; node: MindmapNode }[] = []) {
  out.push({ depth, node });
  for (const child of node.children) walk(child, depth + 1, out);
  return out;
}

/** A wide, deep tree citing the group's chunks, deeper and wider than allowed. */
function oversizedTree(user: string) {
  const handles = promptHandles(user);
  const nodes: Record<string, unknown>[] = [];
  let key = 0;
  const add = (parentKey: string | null, depth: number) => {
    const own = `k${key++}`;
    const handle = handles[key % handles.length]!;
    nodes.push({
      key: own,
      parentKey,
      label: `Node ${own}`,
      summary: `FACT-${handle.slice(1)} detail`,
      refs: [handle],
    });
    if (depth < 6) {
      for (let i = 0; i < (depth < 2 ? 10 : 1); i += 1) add(own, depth + 1);
    }
  };
  add(null, 1);
  add(null, 1);
  return { rootLabel: "Root", rootSummary: null, nodes };
}

test("the mind map respects depth, fan-out and node limits", async () => {
  const { model } = stubModel((call) => oversizedTree(call.user));
  const result = await generateStudyContent(
    { model, anchor: factAnchor() },
    baseInput("mindmap", factChunks(10), {
      options: { count: 80, difficulty: "mixed", language: "en" },
    }),
  );
  if (result.content.kind !== "mindmap") throw new Error("kind");
  studyContentSchema.parse(result.content);
  const nodes = walk(result.content.root);
  assert.ok(nodes.length <= STUDY_LIMITS.mindmapMaxNodes);
  assert.ok(nodes.every(({ depth }) => depth <= STUDY_LIMITS.mindmapMaxDepth));
  assert.ok(
    nodes.every(({ node }) => node.children.length <= STUDY_LIMITS.mindmapMaxFanout),
  );
  assert.ok((result.stats.dropped.fanout ?? 0) > 0);
});

test("many map-reduce groups are bucketed under the root", async () => {
  const { model } = stubModel((call) => {
    const handles = promptHandles(call.user);
    return {
      rootLabel: `Part ${handles[0]}`,
      rootSummary: null,
      nodes: handles.slice(0, 2).map((handle, index) => ({
        key: `n${index}`,
        parentKey: null,
        label: `Point ${handle}`,
        summary: `FACT-${handle.slice(1)} detail`,
        refs: [handle],
      })),
    };
  });
  // Twelve documents of about 6k tokens: twelve groups, more than the fan-out.
  const chunks = Array.from({ length: 12 }, (_, doc) =>
    factChunks(1, { tokens: 6_000, documentId: `doc${doc}` }).map((chunk) => ({
      ...chunk,
      text: chunk.text.replace("FACT-1", `FACT-${doc + 1}`),
    })),
  ).flat();
  const result = await generateStudyContent(
    { model, anchor: factAnchor() },
    baseInput("mindmap", chunks, {
      options: { count: 60, difficulty: "mixed", language: "en" },
      rootLabel: "My sources",
    }),
  );
  if (result.content.kind !== "mindmap") throw new Error("kind");
  const root = result.content.root;
  assert.equal(root.label, "My sources");
  assert.ok(root.children.length <= STUDY_LIMITS.mindmapMaxFanout);
  assert.ok(walk(root).every(({ depth }) => depth <= STUDY_LIMITS.mindmapMaxDepth));
  const leaves = walk(root).filter(({ node }) => node.children.length === 0);
  assert.equal(leaves.length, 12);
  assert.equal(root.children.length, 6);
  assert.ok(leaves.every(({ node }) => node.evidence.length > 0));
});

test("a node in the wrong language is removed and its children move up", async () => {
  const { model } = stubModel(() => ({
    rootLabel: "Root",
    rootSummary: null,
    nodes: [
      { key: "a", parentKey: null, label: "第一部分", summary: "FACT-1 的中文说明", refs: ["c1"] },
      { key: "a1", parentKey: "a", label: "Child one", summary: "FACT-2 detail", refs: ["c2"] },
      { key: "a2", parentKey: "a", label: "Child two", summary: "FACT-3 detail", refs: ["c3"] },
      { key: "b", parentKey: null, label: "Second part", summary: "FACT-4 detail", refs: ["c4"] },
      { key: "x", parentKey: "missing", label: "Orphan", summary: "FACT-5 detail", refs: ["c5"] },
    ],
  }));
  const result = await generateStudyContent(
    { model, anchor: factAnchor() },
    baseInput("mindmap", factChunks(6), {
      options: { count: 10, difficulty: "mixed", language: "en" },
    }),
  );
  if (result.content.kind !== "mindmap") throw new Error("kind");
  assert.deepEqual(
    result.content.root.children.map((child) => child.label),
    ["Child one", "Child two", "Second part"],
  );
  assert.equal(result.stats.dropped.wrongLanguage, 1);
  assert.equal(result.stats.dropped.badParent, 1);
});

/** Twelve documents of about 6k tokens each: twelve map-reduce groups. */
function twelveGroupChunks() {
  return Array.from({ length: 12 }, (_, doc) =>
    factChunks(1, { tokens: 6_000, documentId: `doc${doc}` }).map((chunk) => ({
      ...chunk,
      text: chunk.text.replace("FACT-1", `FACT-${doc + 1}`),
    })),
  ).flat();
}

function contentNodes(root: MindmapNode) {
  return walk(root).filter(({ node }) => node.evidence.length > 0);
}

test("with many groups, every group keeps a node before any keeps a second", async () => {
  const { model } = stubModel((call) => {
    const handle = promptHandles(call.user)[0]!;
    const fact = `FACT-${handle.slice(1)}`;
    return {
      rootLabel: `Part ${handle}`,
      rootSummary: null,
      nodes: [
        { key: "t", parentKey: null, label: `Topic ${handle}`, summary: `${fact} overview`, refs: [handle] },
        { key: "a", parentKey: "t", label: `Alpha ${handle}`, summary: `${fact} first`, refs: [handle] },
        { key: "b", parentKey: "t", label: `Omega ${handle}`, summary: `${fact} second`, refs: [handle] },
      ],
    };
  });
  const result = await generateStudyContent(
    { model, anchor: factAnchor() },
    baseInput("mindmap", twelveGroupChunks(), {
      options: { count: 20, difficulty: "mixed", language: "en" },
      rootLabel: "My sources",
    }),
  );
  if (result.content.kind !== "mindmap") throw new Error("kind");
  const content = contentNodes(result.content.root);
  const groupsShown = new Set(content.map(({ node }) => node.evidence[0]!.chunkId));
  assert.equal(groupsShown.size, 12, "every group is in the map");
  assert.equal(content.length, 20, "the budget counts content nodes only");
  assert.equal(result.stats.kept, 20);
  assert.ok(walk(result.content.root).length <= STUDY_LIMITS.mindmapMaxNodes);
});

test("past the fan-out, the children with the most beneath them are kept, in order", async () => {
  const names = ["Apple", "Bridge", "Castle", "Desert", "Engine", "Forest", "Garden", "Harbor", "Island", "Jungle"];
  const { model } = stubModel(() => {
    const nodes: Record<string, unknown>[] = [];
    for (let index = 1; index <= 10; index += 1) {
      nodes.push({ key: `p${index}`, parentKey: null, label: names[index - 1], summary: `FACT-${index} detail`, refs: [`c${index}`] });
    }
    for (const parent of [9, 10]) {
      for (let child = 1; child <= 5; child += 1) {
        nodes.push({ key: `p${parent}-${child}`, parentKey: `p${parent}`, label: `Sub ${parent} item ${"abcde"[child - 1]}`, summary: `FACT-${parent} part ${child}`, refs: [`c${parent}`] });
      }
    }
    return { rootLabel: "Root", rootSummary: null, nodes };
  });
  const result = await generateStudyContent(
    { model, anchor: factAnchor() },
    baseInput("mindmap", factChunks(12), {
      options: { count: 40, difficulty: "mixed", language: "en" },
    }),
  );
  if (result.content.kind !== "mindmap") throw new Error("kind");
  assert.deepEqual(
    result.content.root.children.map((child) => child.label),
    ["Apple", "Bridge", "Castle", "Desert", "Engine", "Forest", "Island", "Jungle"],
  );
  assert.equal(result.stats.dropped.fanout, 2);
  assert.equal(result.stats.kept, 18);
});
