import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisualQaJudgePrompt,
  parseVisualQaVerdicts,
} from "../src/visual-qa";

test("judge prompt names the slides and canvas", () => {
  const prompt = buildVisualQaJudgePrompt({
    slideNumbers: [1, 2, 3],
    canvas: { width: 1920, height: 1080 },
  });
  assert.match(prompt, /slides: 1, 2, 3/);
  assert.match(prompt, /1920x1080/);
  assert.match(prompt, /text_cutoff/);
});

test("parses a valid verdict payload, including fenced JSON", () => {
  const payload = JSON.stringify({
    verdicts: [
      {
        slideNumber: 2,
        ok: false,
        issues: [
          {
            type: "text_cutoff",
            severity: "severe",
            description: "Title clipped at right edge",
          },
        ],
      },
    ],
  });
  const plain = parseVisualQaVerdicts(payload);
  assert.equal(plain?.length, 1);
  assert.equal(plain?.[0]?.slideNumber, 2);
  assert.equal(plain?.[0]?.issues[0]?.severity, "severe");

  const fenced = parseVisualQaVerdicts("```json\n" + payload + "\n```");
  assert.equal(fenced?.length, 1);
});

test("returns null for malformed verdicts", () => {
  assert.equal(parseVisualQaVerdicts("not json"), null);
  assert.equal(
    parseVisualQaVerdicts(JSON.stringify({ verdicts: [{ bad: true }] })),
    null,
  );
});
