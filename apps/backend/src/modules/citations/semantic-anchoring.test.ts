import assert from "node:assert/strict";
import { test } from "vitest";
import {
  needsSemanticPass,
  pickSemanticAnchor,
  scriptOf,
  segmentTextForEmbedding,
  type EmbeddedSegment,
} from "./semantic-anchoring";

test("the dominant script is read from the text", () => {
  assert.equal(scriptOf("Revenue grew 23% in fiscal 2025."), "latin");
  assert.equal(scriptOf("2025财年营收增长23%，达到41亿美元。"), "cjk");
  assert.equal(scriptOf("売上は23%増加した。"), "cjk");
  assert.equal(scriptOf("12 34 %"), "other");
});

test("only a claim and a source in different scripts need the second pass", () => {
  assert.equal(needsSemanticPass("营收增长23%", "Revenue grew 23%."), true);
  assert.equal(needsSemanticPass("Revenue grew 23%", "营收增长23%。"), true);
  assert.equal(needsSemanticPass("Revenue grew", "Revenue grew 23%."), false);
  assert.equal(needsSemanticPass("营收增长", "营收增长23%。"), false);
  assert.equal(needsSemanticPass("23%", "Revenue grew 23%."), false);
});

test("embedded text has no markup and is bounded", () => {
  assert.equal(
    segmentTextForEmbedding("<td>Team</td>  <td>$49</td>"),
    "Team $49",
  );
  assert.ok(segmentTextForEmbedding("x".repeat(1000)).length <= 400);
});

const CONTENT = "First sentence. Second sentence. Third sentence.";
const at = (text: string) => {
  const start = CONTENT.indexOf(text);
  return { start, end: start + text.length, text };
};
const segment = (text: string, vector: number[]): EmbeddedSegment => ({
  ...at(text),
  vector,
});

test("a clearly best, figure-consistent sentence becomes the strong anchor", () => {
  const anchor = pickSemanticAnchor({
    claim: "营收增长23%",
    claimVector: [1, 0],
    content: CONTENT,
    segments: [
      segment("First sentence.", [0.95, 0.31]),
      segment("Second sentence.", [0.2, 0.98]),
    ].map((item, index) => ({
      ...item,
      text: index === 0 ? "Revenue grew 23%." : item.text,
    })),
  });
  assert.equal(anchor?.support, "strong");
  assert.equal(
    CONTENT.slice(anchor!.startChar!, anchor!.endChar!),
    "First sentence.",
  );
  assert.equal(anchor?.quoteText, "First sentence.");
  assert.ok((anchor?.score ?? 0) > 0.9);
});

test("a best match that is not clearly ahead of the runner-up stays unlocated", () => {
  const anchor = pickSemanticAnchor({
    claim: "营收增长",
    claimVector: [1, 0],
    content: CONTENT,
    segments: [
      segment("First sentence.", [0.9, 0.436]),
      segment("Second sentence.", [0.88, 0.475]),
    ],
  });
  assert.equal(anchor, null);
});

test("a weak match stays unlocated", () => {
  const anchor = pickSemanticAnchor({
    claim: "营收增长",
    claimVector: [1, 0],
    content: CONTENT,
    segments: [
      segment("First sentence.", [0.5, 0.866]),
      segment("Second sentence.", [0.1, 0.995]),
    ],
  });
  assert.equal(anchor, null);
});

test("a close sentence that states different figures stays unlocated", () => {
  const anchor = pickSemanticAnchor({
    claim: "Adults should sleep five hours per night",
    claimVector: [1, 0],
    content: CONTENT,
    segments: [
      {
        ...segment("First sentence.", [0.97, 0.24]),
        text: "成年人每晚建议睡眠七到九小时。",
      },
      segment("Second sentence.", [0.1, 0.995]),
    ],
  });
  assert.equal(anchor, null);
});

test("a source with one sentence can still be matched, and one with none cannot", () => {
  assert.equal(
    pickSemanticAnchor({
      claim: "公司扩大了云业务",
      claimVector: [1, 0],
      content: CONTENT,
      segments: [segment("First sentence.", [0.9, 0.436])],
    })?.support,
    "strong",
  );
  assert.equal(
    pickSemanticAnchor({
      claim: "x",
      claimVector: [1, 0],
      content: CONTENT,
      segments: [],
    }),
    null,
  );
});
