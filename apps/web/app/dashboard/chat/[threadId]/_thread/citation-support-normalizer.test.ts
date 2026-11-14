import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeCitationRecords } from "./message-normalizers";

const base = {
  citation: "c1",
  sourceId: "source-1",
  documentId: "document-1",
  chunkId: "chunk-1",
  score: 0.9,
  excerpt: "excerpt",
};

test("a strong citation keeps its supporting passage offsets", () => {
  const [record] = normalizeCitationRecords([
    {
      ...base,
      support: "strong",
      startChar: 12,
      endChar: 40,
      spanText: "passage",
    },
  ]);
  assert.equal(record?.support, "strong");
  assert.equal(record?.spanText, "passage");
  assert.equal(record?.startChar, 12);
  assert.equal(record?.endChar, 40);
});

test("a weak citation keeps the flag and no offsets", () => {
  const [record] = normalizeCitationRecords([
    { ...base, support: "weak", startChar: 12, endChar: 40 },
  ]);
  assert.equal(record?.support, "weak");
  assert.equal(record?.startChar, undefined);
  assert.equal(record?.endChar, undefined);
});

test("citations from before anchoring carry no support fields", () => {
  const [record] = normalizeCitationRecords([base]);
  assert.ok(record);
  assert.equal("support" in record, false);
  assert.equal("startChar" in record, false);
});

test("unusable offsets are dropped instead of highlighted", () => {
  for (const span of [
    { startChar: 40, endChar: 12 },
    { startChar: 5, endChar: 5 },
    { startChar: -1, endChar: 9 },
    { startChar: 1.5, endChar: 9 },
    { startChar: 3 },
  ]) {
    const [record] = normalizeCitationRecords([
      { ...base, support: "strong", spanText: "passage", ...span },
    ]);
    assert.equal(record?.startChar, undefined, JSON.stringify(span));
    assert.equal(record?.endChar, undefined, JSON.stringify(span));
  }
});

test("an unknown support value is ignored", () => {
  const [record] = normalizeCitationRecords([{ ...base, support: "maybe" }]);
  assert.equal(record?.support, undefined);
});

test("a strong span without its text is dropped", () => {
  const [record] = normalizeCitationRecords([
    { ...base, support: "strong", startChar: 12, endChar: 40 },
  ]);
  assert.equal(record?.startChar, undefined);
  assert.equal(record?.spanText, undefined);
});
