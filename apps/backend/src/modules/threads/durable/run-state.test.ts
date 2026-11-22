import assert from "node:assert/strict";
import { DrizzleQueryError } from "drizzle-orm";
import { test } from "vitest";
import { isUniqueConstraintError } from "./run-state";

/** What node-postgres raises for a unique violation. */
function pgUniqueViolation(constraint: string) {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint,
  });
}

test("a unique violation is recognised by its constraint, raw or wrapped by drizzle", () => {
  const raw = pgUniqueViolation("chat_thread_runs_thread_active_uq");
  // drizzle-orm 0.45 throws a DrizzleQueryError with the driver's error as its cause.
  const wrapped = new DrizzleQueryError("insert into chat_thread_runs ...", [], raw);

  for (const error of [raw, wrapped]) {
    assert.equal(isUniqueConstraintError(error, "chat_thread_runs_thread_active_uq"), true);
    assert.equal(isUniqueConstraintError(error, "chat_thread_runs_idempotency_uq"), false);
  }
  assert.equal(
    isUniqueConstraintError(
      new DrizzleQueryError("select 1", [], Object.assign(new Error("x"), { code: "23503" })),
      "chat_thread_runs_thread_active_uq",
    ),
    false,
  );
  assert.equal(isUniqueConstraintError(null, "chat_thread_runs_thread_active_uq"), false);
});
