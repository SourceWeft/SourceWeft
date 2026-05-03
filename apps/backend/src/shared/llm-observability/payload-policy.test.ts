import assert from "node:assert/strict";
import test from "node:test";
import { applyPayloadPolicy } from "./payload-policy";

test("metadata_only stores only metadata and hash", () => {
  const output = applyPayloadPolicy({
    mode: "metadata_only",
    value: { prompt: "hello", apiKey: "secret" },
  });

  assert.equal(output?.mode, "metadata_only");
  assert.equal(output?.redacted, true);
  assert.equal(typeof output?.sha256, "string");
  assert.equal(JSON.stringify(output).includes("hello"), false);
  assert.equal(JSON.stringify(output).includes("secret"), false);
});

test("preview stores redacted preview and stable hash", () => {
  const value = { prompt: "hello world", token: "secret" };
  const left = applyPayloadPolicy({ mode: "preview", value, previewChars: 80 });
  const right = applyPayloadPolicy({ mode: "preview", value, previewChars: 80 });

  assert.equal(left?.mode, "preview");
  assert.equal(left?.sha256, right?.sha256);
  assert.equal(String(left?.preview).includes("hello world"), true);
  assert.equal(String(left?.preview).includes("secret"), false);
  assert.equal(String(left?.preview).includes("[REDACTED]"), true);
});

test("default mode stores full redacted payloads", () => {
  const output = applyPayloadPolicy({
    value: { text: "hello", password: "secret" },
  });

  assert.equal(output?.mode, "full");
  assert.deepEqual(output?.value, { text: "hello", password: "[REDACTED]" });
  assert.equal(output?.truncated, false);
});

test("full mode redacts without truncating oversized payloads", () => {
  const output = applyPayloadPolicy({
    mode: "full",
    maxJsonBytes: 32,
    value: { text: "x".repeat(200), password: "secret" },
  });

  assert.equal(output?.mode, "full");
  assert.equal(output?.truncated, false);
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.equal((output?.value as { text?: string }).text?.length, 200);
});
