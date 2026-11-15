import assert from "node:assert/strict";
import { test } from "node:test";
import { isAnswerCorrect, scoreQuiz } from "../src/ui/quiz/scoring";
import { quizFixtureEn } from "../src/testing/fixtures";

const [single, multi, truefalse, short] = quizFixtureEn.items;

test("single and true/false need exactly the correct option", () => {
  assert.equal(isAnswerCorrect(single!, { selected: [1] }), true);
  assert.equal(isAnswerCorrect(single!, { selected: [0] }), false);
  assert.equal(isAnswerCorrect(single!, { selected: [1, 0] }), false);
  assert.equal(isAnswerCorrect(single!, undefined), false);
  assert.equal(isAnswerCorrect(truefalse!, { selected: [1] }), true);
  assert.equal(isAnswerCorrect(truefalse!, { selected: [0] }), false);
});

test("multi scores only when every correct option and nothing else is chosen", () => {
  assert.equal(isAnswerCorrect(multi!, { selected: [3, 0, 1] }), true);
  assert.equal(isAnswerCorrect(multi!, { selected: [0, 1] }), false);
  assert.equal(isAnswerCorrect(multi!, { selected: [0, 1, 2, 3] }), false);
});

test("short answers are never auto-scored", () => {
  assert.equal(isAnswerCorrect(short!, { selfGrade: "knew" }), null);
});

test("the score keeps self-graded short answers apart from the auto score", () => {
  const result = scoreQuiz(quizFixtureEn.items, {
    q_single: { selected: [1] },
    q_multi: { selected: [0] },
    q_truefalse: { selected: [1] },
    q_short: { selfGrade: "knew" },
  });
  assert.deepEqual(result, {
    autoCorrect: 2,
    autoTotal: 3,
    selfKnew: 1,
    selfTotal: 1,
    wrongItemIds: ["q_multi"],
  });
});

test("a short answer graded as missed counts as wrong for practice", () => {
  const result = scoreQuiz([short!], { q_short: { selfGrade: "missed" } });
  assert.equal(result.autoTotal, 0);
  assert.equal(result.selfKnew, 0);
  assert.deepEqual(result.wrongItemIds, ["q_short"]);
});

test("unanswered questions are wrong", () => {
  const result = scoreQuiz(quizFixtureEn.items, {});
  assert.equal(result.autoCorrect, 0);
  assert.deepEqual(result.wrongItemIds, ["q_single", "q_multi", "q_truefalse", "q_short"]);
});
