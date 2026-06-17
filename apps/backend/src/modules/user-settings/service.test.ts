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
