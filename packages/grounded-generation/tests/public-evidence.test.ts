import assert from "node:assert/strict";
import test from "node:test";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import {
  GROUNDED_EVIDENCE_PLACEHOLDER,
  toPublicGroundedEvidence,
  toPublicGroundedEvidenceList,
} from "../src/public-evidence";

const evidence: GroundedEvidence = {
  kind: "chunk",
  sourceId: "source-1",
  documentId: "document-1",
  chunkId: "chunk-1",
  chunkNo: 3,
  headingPath: "Chapter 2 > Pricing",
  quote: "The list price is $40 per seat.",
  startChar: 10,
  endChar: 41,
  quoteHash: `sha256:${"a".repeat(64)}`,
};

test("public evidence keeps where it was cited from and drops the source text", () => {
  const stripped = toPublicGroundedEvidence(evidence);
  assert.deepEqual(stripped, {
    kind: "chunk",
    sourceId: "source-1",
    documentId: "document-1",
    chunkId: "chunk-1",
    chunkNo: 3,
  });
  const serialized = JSON.stringify(stripped);
  for (const field of ["quote", "startChar", "endChar", "quoteHash", "headingPath"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"`), field);
  }
  assert.doesNotMatch(serialized, /list price/);
});

test("an extra field a producer slipped in is not carried to the public payload", () => {
  const stripped = toPublicGroundedEvidence({
    ...evidence,
    chunkNo: undefined,
    sourceText: "the whole chunk",
  } as GroundedEvidence);
  assert.deepEqual(Object.keys(stripped).sort(), [
    "chunkId",
    "documentId",
    "kind",
    "sourceId",
  ]);
});

test("a list is stripped entry by entry and the input is left alone", () => {
  const list = [evidence, { ...evidence, chunkId: "chunk-2" }];
  const stripped = toPublicGroundedEvidenceList(list);
  assert.deepEqual(
    stripped.map((entry) => entry.chunkId),
    ["chunk-1", "chunk-2"],
  );
  assert.equal(list[0]!.quote, evidence.quote);
});

test("the placeholder is valid evidence that carries no source text", () => {
  assert.equal(GROUNDED_EVIDENCE_PLACEHOLDER.kind, "chunk");
  assert.equal(GROUNDED_EVIDENCE_PLACEHOLDER.quote, "-");
  assert.match(GROUNDED_EVIDENCE_PLACEHOLDER.quoteHash, /^sha256:0{64}$/);
});
