import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_USER_SETTINGS,
  getUserSettingsResponseSchema,
  userSettingsSchema,
} from "../src/user-settings";

test("user settings are appearance-only and drop a legacy preview key", () => {
  assert.deepEqual(
    userSettingsSchema.parse({
      appearance: { theme: "dark", language: "en" },
      preview: { gmail: true },
    }),
    { appearance: { theme: "dark", language: "en" } },
  );
  assert.deepEqual(
    getUserSettingsResponseSchema.parse({
      settings: { preview: { gmail: false } },
    }),
    { settings: { appearance: DEFAULT_USER_SETTINGS.appearance } },
  );
  assert.deepEqual(Object.keys(DEFAULT_USER_SETTINGS), ["appearance"]);
});
