import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DECK_VISUAL_QA_ISSUE_TYPES,
  aggregateDeckFindings,
  buildDeckVisualQaJudgePrompt,
  parseDeckVisualQaVerdicts,
  summarizeDeckVerdicts,
} from "../src/visual-qa";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("judge prompt names every rubric issue type and the wire shape", () => {
  const prompt = buildDeckVisualQaJudgePrompt({ slideNumbers: [1, 2, 3] });
  for (const type of DECK_VISUAL_QA_ISSUE_TYPES) {
    assert.ok(prompt.includes(`- ${type}:`), `prompt is missing ${type}`);
  }
  assert.ok(prompt.includes("slides: 1, 2, 3"));
  assert.ok(prompt.includes('{"verdicts":'));
});

test("verdict parsing accepts plain and fenced JSON, rejects garbage", () => {
  const payload = JSON.stringify({
    verdicts: [
      {
        slideNumber: 2,
        ok: false,
        issues: [
          {
            type: "text_cutoff",
            severity: "severe",
            description: "Title clipped at the right edge.",
          },
        ],
      },
    ],
  });
  assert.equal(parseDeckVisualQaVerdicts(payload)?.length, 1);
  assert.equal(
    parseDeckVisualQaVerdicts("```json\n" + payload + "\n```")?.length,
    1,
  );
  assert.equal(parseDeckVisualQaVerdicts("not json at all"), null);
  assert.equal(
    parseDeckVisualQaVerdicts(
      JSON.stringify({
        verdicts: [{ slideNumber: 1, ok: true, issues: [{ type: "made_up" }] }],
      }),
    ),
    null,
  );
});

test("deck findings aggregate bullet_only majority and repeated layouts", () => {
  const bulletIssue = {
    type: "bullet_only" as const,
    severity: "minor" as const,
    description: "Title plus bullets only.",
  };
  const repeatIssue = {
    type: "repeated_layout" as const,
    severity: "minor" as const,
    description: "Same layout as prior slides.",
  };
  const verdicts = [
    { slideNumber: 1, ok: false, issues: [bulletIssue] },
    { slideNumber: 2, ok: false, issues: [bulletIssue, repeatIssue] },
    { slideNumber: 3, ok: true, issues: [] },
    { slideNumber: 4, ok: false, issues: [repeatIssue] },
  ];
  const findings = aggregateDeckFindings(verdicts);
  assert.equal(findings.length, 1, "bullet_only is not a majority of 4");
  assert.match(findings[0]!, /Layout monotony/);

  const majority = aggregateDeckFindings(verdicts.slice(0, 3));
  assert.equal(majority.length, 1);
  assert.match(majority[0]!, /Deck reads as a document/);

  assert.deepEqual(summarizeDeckVerdicts(verdicts), {
    severeCount: 0,
    minorCount: 4,
  });
  assert.deepEqual(aggregateDeckFindings([]), []);
});

test("SKILL.md and the manifest agree with the tool contract", async () => {
  const skillMd = await readFile(join(packageRoot, "SKILL.md"), "utf8");
  assert.ok(
    skillMd.includes("review_deck_visuals"),
    "SKILL.md never tells the agent to call review_deck_visuals",
  );
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "sourceweft.capability.json"), "utf8"),
  ) as { skills: Array<{ runtime?: { tools?: string[] } }> };
  assert.ok(
    manifest.skills[0]?.runtime?.tools?.includes("review_deck_visuals"),
    "manifest runtime.tools does not declare review_deck_visuals",
  );
});
