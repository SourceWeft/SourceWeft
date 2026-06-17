import assert from "node:assert/strict";
import { test } from "vitest";
import { redactHeaders, redactValue, REDACTED_VALUE } from "./redaction";

test("redacts sensitive keys recursively without mutating input", () => {
  const input = {
    apiKey: "sk-secret",
    nested: {
      password: "pw",
      keep: "visible",
      items: [{ accessToken: "token" }, { name: "ok" }],
    },
  };

  const output = redactValue(input) as typeof input;

  assert.equal(output.apiKey, REDACTED_VALUE);
  assert.equal(output.nested.password, REDACTED_VALUE);
  assert.equal(output.nested.keep, "visible");
  assert.equal(output.nested.items[0]?.accessToken, REDACTED_VALUE);
  assert.equal(output.nested.items[1]?.name, "ok");
  assert.equal(input.apiKey, "sk-secret");
});

test("redacts headers case-insensitively", () => {
  const headers = redactHeaders({
    Authorization: "Bearer secret",
    "X-Trace-Id": "trace_1",
    Cookie: "session=secret",
  });

  assert.equal(headers?.Authorization, REDACTED_VALUE);
  assert.equal(headers?.Cookie, REDACTED_VALUE);
  assert.equal(headers?.["X-Trace-Id"], "trace_1");
});

test("does not redact token usage counters", () => {
  const output = redactValue({
    cacheReadTokens: 10,
    cacheWriteTokens: 20,
    cachedTokensTotal: 25,
    inputTokens: 30,
    outputTokens: 40,
    totalTokens: 70,
    sessionId: "thread-1",
    byokProvider: "openai",
    accessToken: "secret-token",
  }) as Record<string, unknown>;

  assert.equal(output.cacheReadTokens, 10);
  assert.equal(output.cacheWriteTokens, 20);
  assert.equal(output.cachedTokensTotal, 25);
  assert.equal(output.inputTokens, 30);
  assert.equal(output.outputTokens, 40);
  assert.equal(output.totalTokens, 70);
  assert.equal(output.sessionId, "thread-1");
  assert.equal(output.byokProvider, "openai");
  assert.equal(output.accessToken, REDACTED_VALUE);
});
