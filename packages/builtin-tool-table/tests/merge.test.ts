import assert from "node:assert/strict";
import test from "node:test";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import { bucketCandidates, resolveColumn, type VerifiedCandidate } from "../src/engine/merge";

const evidence = (chunkId: string, start = 0): GroundedEvidence => ({
  kind: "chunk",
  sourceId: "s",
  documentId: "d",
  chunkId,
  quote: `quote of ${chunkId}`,
  startChar: start,
  endChar: start + 5,
  quoteHash: `sha256:${"c".repeat(64)}`,
});
const candidate = (value: string, ...chunks: string[]): VerifiedCandidate => ({
  value,
  evidence: chunks.map((chunk) => evidence(chunk)),
});
const neverAsked = async () => {
  throw new Error("the merge call must not be made");
};

test("candidates are bucketed by what they state, not by how they are written", () => {
  const buckets = bucketCandidates("number", [
    candidate("1,200", "c1"),
    candidate("1.2k", "c2"),
    candidate("1,300", "c3"),
  ]);
  assert.deepEqual(buckets.map((bucket) => bucket.map((entry) => entry.value)), [
    ["1,200", "1.2k"],
    ["1,300"],
  ]);
});

test("nothing claimed is not_found; claimed but nothing verified is unverified", async () => {
  assert.deepEqual(
    await resolveColumn({ type: "text", claimed: false, verified: [], choose: neverAsked }),
    { status: "not_found" },
  );
  assert.deepEqual(
    await resolveColumn({ type: "text", claimed: true, verified: [], choose: neverAsked }),
    { status: "unverified" },
  );
});

test("a single candidate keeps its value and evidence and needs no choice", async () => {
  const outcome = await resolveColumn({
    type: "number",
    claimed: true,
    verified: [candidate("1,200 people", "c1")],
    choose: neverAsked,
  });
  assert.equal(outcome.status, "found");
  if (outcome.status === "found") {
    assert.equal(outcome.value, "1,200 people");
    assert.equal(outcome.normalized, 1200);
    assert.deepEqual(outcome.evidence.map((entry) => entry.chunkId), ["c1"]);
  }
});

test("agreeing candidates merge at most two pieces of evidence, without duplicates, and ask nothing", async () => {
  const outcome = await resolveColumn({
    type: "text",
    claimed: true,
    verified: [
      candidate("Randomised trial", "c1", "c1"),
      candidate("randomised  trial.", "c2"),
      candidate("RANDOMISED TRIAL", "c3"),
    ],
    choose: neverAsked,
  });
  assert.equal(outcome.status, "found");
  if (outcome.status === "found") {
    assert.equal(outcome.value, "Randomised trial");
    assert.deepEqual(outcome.evidence.map((entry) => entry.chunkId), ["c1", "c2"]);
    assert.equal("normalized" in outcome, false);
  }
});

test("differing candidates ask once, with one candidate per distinct value, and keep the chosen one's evidence", async () => {
  let asked: readonly VerifiedCandidate[] = [];
  const outcome = await resolveColumn({
    type: "number",
    claimed: true,
    verified: [candidate("1,200", "c1"), candidate("1.2k", "c2"), candidate("1,500", "c3")],
    choose: async (options) => {
      asked = options;
      return 1;
    },
  });
  assert.deepEqual(asked.map((entry) => entry.value), ["1,200", "1,500"]);
  assert.equal(outcome.status, "found");
  if (outcome.status === "found") {
    assert.equal(outcome.value, "1,500");
    assert.deepEqual(outcome.evidence.map((entry) => entry.chunkId), ["c3"]);
  }
});

test("a choice outside the candidates, or none, is unverified", async () => {
  const verified = [candidate("1,200", "c1"), candidate("1,500", "c2")];
  for (const choice of [null, -1, 2, 99]) {
    assert.deepEqual(
      await resolveColumn({ type: "number", claimed: true, verified, choose: async () => choice }),
      { status: "unverified" },
      String(choice),
    );
  }
});
