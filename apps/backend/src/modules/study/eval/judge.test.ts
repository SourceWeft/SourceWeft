import assert from "node:assert/strict";
import type { StudyContent, StudyEvidence } from "@sourceweft/contracts/study";
import { describe, test } from "vitest";
import { citedTextOf, judgeContent, type JudgeCall } from "./judge";

const chunkTextById = new Map([
  ["c1", "Water boils at 100 degrees at sea level."],
  ["c2", "Ice melts at 0 degrees."],
]);

const ev = (chunkId: string): StudyEvidence => ({
  kind: "chunk",
  sourceId: "s",
  documentId: "d",
  chunkId,
  quote: "q",
  quoteHash: `sha256:${"0".repeat(64)}`,
});

function quizContent(): StudyContent {
  return {
    kind: "quiz",
    items: [
      {
        id: "q_ok",
        type: "single",
        stem: "Boiling point?",
        options: ["100", "90", "80"],
        correct: [0],
        explanation: "It boils at 100.",
        evidence: [ev("c1")],
      },
      {
        id: "q_multi",
        type: "single",
        stem: "Which is a temperature?",
        options: ["100", "0", "red"],
        correct: [0],
        explanation: "100 degrees.",
        evidence: [ev("c1"), ev("c2"), ev("c1")],
      },
      {
        id: "q_short",
        type: "short",
        stem: "When does ice melt?",
        referenceAnswer: "At 0 degrees.",
        explanation: "Ice melts at 0.",
        evidence: [ev("c2")],
      },
    ],
  } as unknown as StudyContent;
}

describe("judge", () => {
  test("cites each chunk once, in citation order", () => {
    assert.equal(
      citedTextOf([ev("c2"), ev("c1"), ev("c2")], chunkTextById),
      "Ice melts at 0 degrees.\n\nWater boils at 100 degrees at sea level.",
    );
  });

  test("answerable only when the blind judge picks exactly the marked options", async () => {
    const calls: string[] = [];
    const call: JudgeCall = async ({ key, schema, user }) => {
      calls.push(key);
      if (schema.name === "study_eval_options") {
        return key.includes("q_multi")
          ? { determinable: true, correctOptions: [1, 0], reason: "both" }
          : { determinable: true, correctOptions: [0], reason: "one" };
      }
      if (schema.name === "study_eval_explanation") {
        return { markedAnswerSupported: true, explanationSupported: true, reason: "" };
      }
      assert.ok(user.includes("Given answer: At 0 degrees."));
      return { questionAnswerable: true, answerCorrect: true, answerSupported: false, reason: "extra claim" };
    };
    const { verdicts } = await judgeContent({ content: quizContent(), chunkTextById, call, keyRoot: "run" });
    const byId = Object.fromEntries(verdicts.map((verdict) => [verdict.itemId, verdict]));
    assert.equal(byId.q_ok!.answerable, true);
    assert.equal(byId.q_ok!.faithful, true);
    assert.equal(byId.q_multi!.answerable, false);
    assert.deepEqual(byId.q_multi!.chosenOptions, [0, 1]);
    assert.equal(byId.q_short!.answerable, true);
    assert.equal(byId.q_short!.faithful, false);
    assert.equal(new Set(calls).size, calls.length, "every call has its own billing key");
    assert.equal(calls.length, 5);
  });

  test("an unreadable or failed judge answer counts against the item", async () => {
    const content = {
      kind: "flashcards",
      items: [
        { id: "c_bad", front: "Q", back: "A", tags: [], difficulty: 1, evidence: [ev("c1")] },
        { id: "c_err", front: "Q2", back: "A2", tags: [], difficulty: 1, evidence: [ev("c1")] },
      ],
    } as unknown as StudyContent;
    const call: JudgeCall = async ({ key }) => {
      if (key.includes("c_err")) throw new Error("gateway down");
      return { questionAnswerable: "yes" };
    };
    const { verdicts } = await judgeContent({ content, chunkTextById, call, keyRoot: "run" });
    assert.deepEqual(
      verdicts.map((verdict) => [verdict.itemId, verdict.invalid, verdict.answerable, verdict.faithful]),
      [
        ["c_bad", true, false, false],
        ["c_err", true, false, false],
      ],
    );
  });

  test("mind map nodes without evidence are skipped, not judged", async () => {
    const content = {
      kind: "mindmap",
      root: {
        id: "n_root",
        label: "Root",
        evidence: [],
        children: [
          { id: "n_group", label: "Group", evidence: [], children: [
            { id: "n_leaf", label: "Boiling", summary: "Water boils at 100.", evidence: [ev("c1")], children: [] },
          ] },
        ],
      },
    } as unknown as StudyContent;
    const call: JudgeCall = async () => ({ supported: true, reason: "" });
    const result = await judgeContent({ content, chunkTextById, call, keyRoot: "run" });
    assert.equal(result.skippedWithoutEvidence, 1);
    assert.deepEqual(
      result.verdicts.map((verdict) => [verdict.itemId, verdict.faithful, verdict.answerable]),
      [["n_leaf", true, null]],
    );
  });
});
