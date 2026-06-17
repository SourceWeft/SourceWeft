import assert from "node:assert/strict";
import { test } from "vitest";
import { isPlaceholderThreadTitle, normalizeGeneratedChatTitle } from "./title";

test("only recognizes the UI default thread title as placeholder", () => {
  assert.equal(isPlaceholderThreadTitle("New chat"), true);
  assert.equal(isPlaceholderThreadTitle("New Thread"), false);
  assert.equal(isPlaceholderThreadTitle("New conversation"), false);
  assert.equal(isPlaceholderThreadTitle("New conversation 12"), false);
  assert.equal(isPlaceholderThreadTitle("New chat about billing"), false);
  assert.equal(isPlaceholderThreadTitle("Project kickoff"), false);
});

test("normalizes generated chat titles", () => {
  assert.equal(
    normalizeGeneratedChatTitle('"Billing status?"'),
    "Billing status",
  );
  assert.equal(normalizeGeneratedChatTitle("   "), null);
});
