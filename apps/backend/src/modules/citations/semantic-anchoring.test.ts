import assert from "node:assert/strict";
import { test } from "vitest";
import {
  directionsConflict,
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
  assert.equal(segmentTextForEmbedding("| Team | 25 | $49 |"), "Team, 25, $49");
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

test("opposite directions with the same figures conflict, across languages", () => {
  assert.equal(
    directionsConflict(
      "Net sales fell 14% to $7.8 billion",
      "第二季度净销售额增长14%，达到78亿美元。",
    ),
    true,
  );
  assert.equal(
    directionsConflict(
      "第二季度净销售额下降14%",
      "Net sales rose 14% in the second quarter.",
    ),
    true,
  );
  assert.equal(
    directionsConflict(
      "Battery capacity dropped from 82 kWh to 60 kWh",
      "电池容量从60千瓦时提高到82千瓦时。",
    ),
    true,
  );
});

test("the same direction, no direction, or both directions do not conflict", () => {
  assert.equal(
    directionsConflict("Net sales grew 14%", "净销售额增长14%"),
    false,
  );
  assert.equal(
    directionsConflict("Net sales were 14% of the total", "净销售额增长14%"),
    false,
  );
  assert.equal(
    directionsConflict("Sales rose while costs fell", "销售额下降，成本增长"),
    false,
  );
  assert.equal(
    directionsConflict(
      "Remote work is permitted up to three days",
      "每周最多可远程办公三天",
    ),
    false,
  );
});

test("a close sentence that says the opposite direction stays unlocated", () => {
  const anchor = pickSemanticAnchor({
    claim: "Net sales fell 14%",
    claimVector: [1, 0],
    content: CONTENT,
    segments: [
      {
        ...segment("First sentence.", [0.97, 0.24]),
        text: "净销售额增长14%。",
      },
      segment("Second sentence.", [0.1, 0.995]),
    ],
  });
  assert.equal(anchor, null);
});

test("rows that read alike are told apart by figures only one of them states", () => {
  const rows = [
    { ...segment("First sentence.", [0.93, 0.37]), text: "Starter, 5, $9" },
    { ...segment("Second sentence.", [0.92, 0.39]), text: "Team, 25, $49" },
    {
      ...segment("Third sentence.", [0.91, 0.41]),
      text: "Business, 100, $199",
    },
  ];
  const anchor = pickSemanticAnchor({
    claim: "团队版包含25个席位，售价49美元",
    claimVector: [1, 0],
    content: CONTENT,
    segments: rows,
  });
  assert.equal(anchor?.support, "strong");
  assert.equal(anchor?.quoteText, "Second sentence.");
});

test("rows that read alike stay unlocated when the figures do not single one out", () => {
  const rows = [
    { ...segment("First sentence.", [0.93, 0.37]), text: "Team, 25, $49" },
    {
      ...segment("Second sentence.", [0.92, 0.39]),
      text: "Team, 25, $49 (annual)",
    },
  ];
  assert.equal(
    pickSemanticAnchor({
      claim: "团队版包含25个席位，售价49美元",
      claimVector: [1, 0],
      content: CONTENT,
      segments: rows,
    }),
    null,
  );
  assert.equal(
    pickSemanticAnchor({
      claim: "团队版很受欢迎",
      claimVector: [1, 0],
      content: CONTENT,
      segments: [
        { ...segment("First sentence.", [0.93, 0.37]), text: "Starter" },
        { ...segment("Second sentence.", [0.92, 0.39]), text: "Team" },
      ],
    }),
    null,
  );
});
