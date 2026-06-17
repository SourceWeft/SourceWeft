import assert from "node:assert/strict";
import { test } from "vitest";
import { updateThreadChatPreferencesRequestSchema } from "@sourceweft/contracts";
import {
  DEFAULT_THREAD_CHAT_PREFERENCES,
  mergeThreadChatPreferences,
  normalizeThreadChatPreferences,
} from "./chat-preferences";

test("normalizeThreadChatPreferences applies defaults and drops unknown fields", () => {
  assert.deepEqual(
    normalizeThreadChatPreferences({
      thinking: { mode: "off", effort: "high", extra: true },
      webAccess: false,
      composerOptions: { density: "compact" },
      mcpInstallId: "workspace-mcp-1",
    }),
    {
      thinking: { mode: "off", effort: "high" },
      webAccess: false,
      composerOptions: { density: "compact" },
    },
  );
});

test("normalizeThreadChatPreferences falls back for invalid values", () => {
  assert.deepEqual(
    normalizeThreadChatPreferences({
      thinking: { mode: "always", effort: "extreme" },
      webAccess: "yes",
    }),
    DEFAULT_THREAD_CHAT_PREFERENCES,
  );
});

test("normalizeThreadChatPreferences strips secret-like composer option keys", () => {
  assert.deepEqual(
    normalizeThreadChatPreferences({
      composerOptions: {
        apiKey: "sk-test",
        nested: {
          accessToken: "secret",
          safe: true,
        },
      },
    }).composerOptions,
    {
      nested: {
        safe: true,
      },
    },
  );
});

test("normalizeThreadChatPreferences rejects oversized json", () => {
  assert.deepEqual(
    normalizeThreadChatPreferences({
      composerOptions: { prompt: "x".repeat(20 * 1024) },
    }),
    DEFAULT_THREAD_CHAT_PREFERENCES,
  );
});

test("mergeThreadChatPreferences keeps untouched fields", () => {
  assert.deepEqual(
    mergeThreadChatPreferences(
      {
        thinking: { mode: "effort", effort: "high" },
        webAccess: false,
        composerOptions: { density: "compact" },
      },
      { thinking: { effort: "minimal" } },
    ),
    {
      thinking: { mode: "effort", effort: "minimal" },
      webAccess: false,
      composerOptions: { density: "compact" },
    },
  );
});

test("updateThreadChatPreferencesRequestSchema rejects empty patches", () => {
  assert.equal(
    updateThreadChatPreferencesRequestSchema.safeParse({}).success,
    false,
  );
  assert.equal(
    updateThreadChatPreferencesRequestSchema.safeParse({ thinking: {} })
      .success,
    false,
  );
  assert.equal(
    updateThreadChatPreferencesRequestSchema.safeParse({
      thinking: { mode: "auto" },
    }).success,
    true,
  );
});
