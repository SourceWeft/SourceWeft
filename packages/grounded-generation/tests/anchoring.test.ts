import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorCandidates,
  citedTextWithin,
  evidenceFrom,
  quoteHash,
} from "../src/anchoring";
import type { CorpusChunk } from "../src/types";

function chunk(handle: string, text: string, tokens: number): CorpusChunk {
  return {
    handle,
    tokens,
    chunkId: `chunk-${handle}`,
    sourceId: "s1",
    documentId: "d1",
    chunkNo: 0,
    headingPath: "Intro",
    language: "en",
    text,
  };
}

test("quoteHash is the sha256 digest of the quote", () => {
  assert.equal(
    quoteHash("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("evidenceFrom cuts a quote over the limit and hashes the cut text", () => {
  const evidence = evidenceFrom(
    chunk("c1", "x", 1),
    { startChar: 10, endChar: 20, quote: "abcdefghij", confidence: 1 },
    4,
  );
  assert.equal(evidence.quote, "abcd");
  assert.equal(evidence.startChar, 10);
  assert.equal(evidence.endChar, 14);
  assert.equal(evidence.quoteHash, quoteHash("abcd"));
  assert.equal(evidence.chunkId, "chunk-c1");
  assert.equal(evidence.headingPath, "Intro");
});

test("anchorCandidates keeps at most the allowed evidence and skips unsupported items", async () => {
  const chunks = new Map([
    ["c1", chunk("c1", "alpha beta", 3)],
    ["c2", chunk("c2", "gamma delta", 3)],
    ["c3", chunk("c3", "epsilon", 2)],
  ]);
  const requested: { text: string; chunkId: string }[] = [];
  const evidence = await anchorCandidates(
    [
      { id: "i1", refs: ["c1", "c2", "c3"], text: "supports i1" },
      { id: "i2", refs: ["c3", "missing"], text: "supports i2" },
    ],
    {
      async anchor(requests) {
        requested.push(...requests.map(({ text, chunkId }) => ({ text, chunkId })));
        return requests.map((request) =>
          request.chunkId === "chunk-c3"
            ? null
            : { startChar: 0, endChar: 5, quote: "alpha", confidence: 1 },
        );
      },
    },
    chunks,
    { evidencePerItem: 1 },
  );
  assert.equal(requested.length, 4);
  assert.deepEqual([...evidence.keys()], ["i1"]);
  assert.equal(evidence.get("i1")!.length, 1);
  assert.equal(evidence.get("i1")![0]!.chunkId, "chunk-c1");
});

test("citedTextWithin joins whole chunks and cuts the one that crosses the budget", () => {
  const chunks = [chunk("c1", "abcd", 1), chunk("c2", "efghijklmnop", 3)];
  assert.equal(citedTextWithin(chunks, 10), "abcd\n\nefghijklmnop");
  assert.equal(citedTextWithin(chunks, 2), "abcd\n\nefgh");
  assert.equal(citedTextWithin(chunks, 0), "");
});
