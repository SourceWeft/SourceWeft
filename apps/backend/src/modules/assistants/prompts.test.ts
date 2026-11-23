import assert from "node:assert/strict";
import { test } from "vitest";
import { ASSISTANT_LIMITS } from "./limits";
import { ROUTER_PROMPT } from "./router/prompt";
import { WORKER_PROMPT } from "./worker/prompt";

/** The Chinese half and the English half: each must stand on its own. */
function halves(prompt: string): [string, string] {
  const [zh, en] = prompt.split("\n---\n");
  assert.ok(zh && en);
  return [zh, en];
}

test("each half of the Router prompt states the rework rule, its limit, and that the Router never writes the deliverable", () => {
  const [zh, en] = halves(ROUTER_PROMPT);
  const limit = String(ASSISTANT_LIMITS.reworkWithoutMemberMax);
  assert.match(zh, /返工/);
  assert.ok(zh.includes(`最多返工 ${limit} 次`));
  assert.match(zh, /从不撰写成果/);
  assert.match(en, /rework/);
  assert.ok(en.includes(`at most ${limit} times`));
  assert.match(en, /never write the deliverable yourself/);
});

test("each half of the Router prompt accepts a ready report that points to /files", () => {
  const [zh, en] = halves(ROUTER_PROMPT);
  assert.match(zh, /\/files/);
  assert.match(en, /\/files/);
});

test("the Router prompt no longer says undecided events take the whole assistant offline", () => {
  assert.doesNotMatch(ROUTER_PROMPT, /offline/);
  assert.doesNotMatch(ROUTER_PROMPT, /整个助理停摆/);
});

test("each half of the Worker prompt says a router note is the assistant's instruction and that the summary carries the result", () => {
  const [zh, en] = halves(WORKER_PROMPT);
  for (const half of [zh, en]) {
    assert.match(half, /<router-note>/);
    assert.match(half, /\/files/);
    assert.match(half, /2000/);
  }
});
