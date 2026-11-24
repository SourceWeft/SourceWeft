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

test("each half of the Router prompt accepts a ready report whose full result is in the ticket's conversation, never a /files pointer", () => {
  const [zh, en] = halves(ROUTER_PROMPT);
  assert.match(zh, /完整结果在工单对话里/);
  assert.match(en, /full result is in the ticket's conversation/);
  // Ticket turns are read-only: a worker cannot write under /files.
  assert.doesNotMatch(ROUTER_PROMPT, /\/files/);
});

test("each half of the Router prompt limits rework to ready or dropped reports", () => {
  const [zh, en] = halves(ROUTER_PROMPT);
  assert.match(zh, /ready 或 dropped/);
  assert.match(en, /`ready` or `dropped`/);
});

test("each half of the Router prompt keeps tool names, ids and errors out of say, and does not recall what the batch already holds", () => {
  const [zh, en] = halves(ROUTER_PROMPT);
  assert.match(zh, /不要提工具名、id、错误码/);
  assert.match(zh, /本批事件的全文就在本批里，不用再查/);
  assert.match(en, /never mention tool names, ids, error codes/);
  assert.match(
    en,
    /already holds each event's full text, so do not look it up again/,
  );
});

test("the Router prompt no longer says undecided events take the whole assistant offline", () => {
  assert.doesNotMatch(ROUTER_PROMPT, /offline/);
  assert.doesNotMatch(ROUTER_PROMPT, /整个助理停摆/);
});

test("each half of the Worker prompt says a router note is the assistant's instruction and that the summary carries the result", () => {
  const [zh, en] = halves(WORKER_PROMPT);
  assert.match(zh, /最终回答/);
  assert.match(en, /final answer/);
  for (const half of [zh, en]) {
    assert.match(half, /<router-note>/);
    assert.match(half, /2000/);
    assert.doesNotMatch(half, /\/files/);
  }
});
