import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILL_CONCURRENCY,
  MAX_UNVERIFIED_SHARE,
  SUGGEST_MAX_COLUMNS,
  SUGGEST_MIN_COLUMNS,
  SUGGEST_SUMMARY_CHARS,
  TABLE_JOB_ATTEMPTS,
  TABLE_JOB_TIMEOUT_MS,
  TABLE_PROMPT_VERSION,
} from "../src/engine/constants";

test("table engine constants keep their pinned values", () => {
  assert.equal(TABLE_PROMPT_VERSION, "table-v1");
  assert.equal(FILL_CONCURRENCY, 4);
  assert.equal(MAX_UNVERIFIED_SHARE, 0.4);
  assert.equal(SUGGEST_MIN_COLUMNS, 4);
  assert.equal(SUGGEST_MAX_COLUMNS, 8);
  assert.equal(SUGGEST_SUMMARY_CHARS, 1_200);
  assert.equal(TABLE_JOB_TIMEOUT_MS, 1_200_000);
  assert.equal(TABLE_JOB_ATTEMPTS, 2);
});

test("the suggested column range is not inverted", () => {
  assert.ok(SUGGEST_MIN_COLUMNS <= SUGGEST_MAX_COLUMNS);
});
