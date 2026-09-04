import assert from "node:assert/strict";
import { test } from "vitest";
import { updateUserSettingsRequestSchema } from "@sourceweft/contracts";
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  normalizeUserSettings,
} from "./settings";

test("normalizeUserSettings applies defaults and drops unknown fields", () => {
  assert.deepEqual(
    normalizeUserSettings({
      appearance: { theme: "dark", density: "compact" },
      workspaceId: "workspace-1",
    }),
    {
      appearance: { theme: "dark" },
    },
  );
});

test("normalizeUserSettings falls back for invalid settings", () => {
  assert.deepEqual(
    normalizeUserSettings({
      appearance: { theme: "sepia" },
    }),
    DEFAULT_USER_SETTINGS,
  );
});

test("normalizeUserSettings rejects secret-like keys", () => {
  assert.deepEqual(
    normalizeUserSettings({
      appearance: { theme: "light" },
      apiKey: "sk-test",
    }),
    DEFAULT_USER_SETTINGS,
  );
});

test("normalizeUserSettings rejects oversized json", () => {
  assert.deepEqual(
    normalizeUserSettings({
      appearance: { theme: "dark" },
      notes: "x".repeat(20 * 1024),
    }),
    DEFAULT_USER_SETTINGS,
  );
});

test("mergeUserSettings keeps existing appearance fields", () => {
  assert.deepEqual(
    mergeUserSettings(
      { appearance: { theme: "light" } },
      { appearance: { theme: "dark" } },
    ),
    { appearance: { theme: "dark" } },
  );
});

test("updateUserSettingsRequestSchema rejects empty patches", () => {
  assert.equal(updateUserSettingsRequestSchema.safeParse({}).success, false);
  assert.equal(
    updateUserSettingsRequestSchema.safeParse({ appearance: {} }).success,
    false,
  );
  assert.equal(
    updateUserSettingsRequestSchema.safeParse({
      appearance: { theme: "system" },
    }).success,
    true,
  );
});

test("normalizeUserSettings handles a user with no stored settings", () => {
  // The read path for every user who has never saved settings: the query finds
  // no row, so `rows[0]?.settings` is undefined. `JSON.stringify(undefined)`
  // returns undefined rather than a string, which used to throw inside
  // `Buffer.byteLength` and 500 the whole settings endpoint.
  assert.deepEqual(normalizeUserSettings(undefined), DEFAULT_USER_SETTINGS);
  assert.deepEqual(normalizeUserSettings(null), DEFAULT_USER_SETTINGS);
});

test("normalizeUserSettings handles values with no JSON representation", () => {
  assert.deepEqual(normalizeUserSettings(() => {}), DEFAULT_USER_SETTINGS);
  assert.deepEqual(normalizeUserSettings(Symbol("x")), DEFAULT_USER_SETTINGS);
});
