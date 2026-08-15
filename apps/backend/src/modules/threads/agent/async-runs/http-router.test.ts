import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryRunsStore } from "./in-memory-store";
import {
  handleCancelRun,
  handleCreateRun,
  handleCreateThread,
  handleGetRun,
  handleGetThreadState,
  handleListRuns,
  parseCreateRunBody,
} from "./http-router";

function store() {
  return new InMemoryRunsStore(() => "2026-01-01T00:00:00.000Z");
}

test("parseCreateRunBody requires assistant_id and defaults strategy to reject", () => {
  assert.deepEqual(parseCreateRunBody({ assistant_id: "explore" }), {
    assistantId: "explore",
    multitaskStrategy: "reject",
  });
  assert.deepEqual(
    parseCreateRunBody({ assistant_id: "explore", multitask_strategy: "interrupt" }),
    { assistantId: "explore", multitaskStrategy: "interrupt" },
  );
  assert.equal(parseCreateRunBody({}), null);
  assert.equal(parseCreateRunBody(null), null);
  // unknown strategy falls back to reject
  assert.equal(
    parseCreateRunBody({ assistant_id: "x", multitask_strategy: "bogus" })
      ?.multitaskStrategy,
    "reject",
  );
});

test("create thread → create run returns Agent-Protocol wire shapes", async () => {
  const s = store();
  const thread = (await handleCreateThread(s)).body as { thread_id: string };
  assert.equal((await handleCreateThread(s)).status, 201);
  assert.match(thread.thread_id, /^thread_/);

  const created = await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
  });
  assert.equal(created.status, 201);
  const run = created.body as Record<string, unknown>;
  assert.equal(run.assistant_id, "explore");
  assert.equal(run.thread_id, thread.thread_id);
  assert.equal(run.status, "running");
  assert.match(String(run.run_id), /^run_/);
});

test("create-run with invalid body is 400", async () => {
  const s = store();
  const thread = (await handleCreateThread(s)).body as { thread_id: string };
  const result = await handleCreateRun(s, thread.thread_id, { nope: true });
  assert.equal(result.status, 400);
});

test("reject strategy on a live run returns 409 with active_run_id", async () => {
  const s = store();
  const thread = (await handleCreateThread(s)).body as { thread_id: string };
  const first = (await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
    multitask_strategy: "reject",
  })).body as { run_id: string };

  const conflict = await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
    multitask_strategy: "reject",
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (conflict.body as { active_run_id: string }).active_run_id,
    first.run_id,
  );
});

test("interrupt strategy over HTTP supersedes the active run", async () => {
  const s = store();
  const thread = (await handleCreateThread(s)).body as { thread_id: string };
  const first = (await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
  })).body as { run_id: string };
  await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
    multitask_strategy: "interrupt",
  });

  const got = await handleGetRun(s, thread.thread_id, first.run_id);
  assert.equal((got.body as { status: string }).status, "interrupted");
});

test("get/list/cancel/state handlers", async () => {
  const s = store();
  const thread = (await handleCreateThread(s)).body as { thread_id: string };
  const run = (await handleCreateRun(s, thread.thread_id, {
    assistant_id: "explore",
  })).body as { run_id: string };

  assert.equal(
    (await handleListRuns(s, thread.thread_id)).body instanceof Array,
    true,
  );
  assert.equal((await handleGetRun(s, thread.thread_id, "nope")).status, 404);

  const cancelled = await handleCancelRun(s, thread.thread_id, run.run_id);
  assert.equal((cancelled.body as { status: string }).status, "cancelled");
  assert.equal((await handleCancelRun(s, thread.thread_id, "nope")).status, 404);

  const state = await handleGetThreadState(s, thread.thread_id);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { values: null });
});
