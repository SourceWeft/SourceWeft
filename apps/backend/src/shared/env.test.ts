import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { parseBooleanEnv, readBooleanEnv } from "./env";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

test("parseBooleanEnv accepts the strict spellings it always accepted", () => {
  for (const value of ["true", "TRUE", " true ", "1"]) {
    assert.equal(parseBooleanEnv(value, false), true, value);
  }
  for (const value of ["false", "FALSE", " false ", "0"]) {
    assert.equal(parseBooleanEnv(value, true), false, value);
  }
});

/**
 * Widened behavior, recorded deliberately.
 *
 * `shared/config.ts` previously recognised only `true`/`1`/`false`/`0`, so
 * every flag it reads — SOURCEWEFT_SAAS_ENABLED, SOURCEWEFT_SANDBOX_ENABLED,
 * MARKET_ENABLED, BACKEND_CREDITS_ENABLED, CREEM_TEST_MODE and the rest — used
 * to ignore `yes`/`on`/`no`/`off`/`disabled` and silently fall back. They now
 * honour those spellings.
 */
test("parseBooleanEnv now honours yes/on/no/off/disabled", () => {
  for (const value of ["yes", "YES", "on", " On "]) {
    assert.equal(parseBooleanEnv(value, false), true, value);
  }
  for (const value of ["no", "NO", "off", "disabled", " Disabled "]) {
    assert.equal(parseBooleanEnv(value, true), false, value);
  }
});

/**
 * Narrowed behavior, recorded deliberately.
 *
 * The context-compression middleware used to read its flags with a helper that
 * treated *any* unrecognised value as `true`
 * (`!["0","false","no","off","disabled"].includes(raw)`), so
 * SOURCEWEFT_AGENT_COMPACTION_ENABLED=banana enabled compaction. Unrecognised
 * values now fall back to the caller's default instead, matching every other
 * flag in the backend.
 */
test("parseBooleanEnv falls back on an unrecognised value rather than guessing", () => {
  assert.equal(parseBooleanEnv("banana", true), true);
  assert.equal(parseBooleanEnv("banana", false), false);
  assert.equal(parseBooleanEnv("", true), true);
  assert.equal(parseBooleanEnv("", false), false);
  assert.equal(parseBooleanEnv(undefined, true), true);
  assert.equal(parseBooleanEnv(undefined, false), false);
});

test("readBooleanEnv reads process.env by name", () => {
  process.env.SOURCEWEFT_ENV_TEST_FLAG = "on";
  assert.equal(readBooleanEnv("SOURCEWEFT_ENV_TEST_FLAG", false), true);

  delete process.env.SOURCEWEFT_ENV_TEST_FLAG;
  assert.equal(readBooleanEnv("SOURCEWEFT_ENV_TEST_FLAG", true), true);
});
