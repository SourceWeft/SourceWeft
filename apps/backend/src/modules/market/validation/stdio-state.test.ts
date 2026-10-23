import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MCP_STDIO_LIMITS,
  parseStdioDriverResult,
  stdioValidationOutcome,
  unsupportedValidation,
} from "./stdio-state";

const NOW = new Date("2026-10-24T10:00:00Z");

test("a result that is not the driver's is null, never a verdict", () => {
  assert.equal(parseStdioDriverResult(""), null);
  assert.equal(parseStdioDriverResult("not json"), null);
  assert.equal(parseStdioDriverResult("[]"), null);
  assert.equal(parseStdioDriverResult(JSON.stringify({ ok: true })), null);
  assert.equal(
    parseStdioDriverResult(JSON.stringify({ ok: false, reason: "cosmic" })),
    null,
  );
});

test("a success keeps the bounded self-description and tools, dropping duplicates and extras", () => {
  const result = parseStdioDriverResult(
    JSON.stringify({
      ok: true,
      protocolVersion: "2025-06-18",
      serverInfo: {
        name: "  Notion MCP  ",
        version: "1.8.1",
        description: "d".repeat(600),
        websiteUrl: "https://notion.so",
        icons: [
          {
            src: "https://notion.so/icon.png",
            mimeType: "image/png",
            sizes: ["48x48"],
          },
          { src: "http://insecure.example/icon.png" },
        ],
        extra: "ignored",
      },
      instructions: "i".repeat(9000),
      capabilities: { tools: { listChanged: false } },
      tools: [
        {
          name: "search",
          description: "s".repeat(2500),
          inputSchema: { type: "object" },
        },
        { name: "search", description: "duplicate" },
        { name: "", description: "nameless" },
        "junk",
        { name: "create", annotations: { readOnlyHint: false } },
      ],
      timings: { installMs: 1200, startMs: 3400 },
      stderrTail: "",
    }),
  );
  assert.ok(result);
  const outcome = stdioValidationOutcome(result, NOW);
  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.validatedAt, NOW.toISOString());
  assert.equal(outcome.selfDescription.source, "stdio-sandbox");
  assert.equal(outcome.selfDescription.recordedAt, NOW.toISOString());
  assert.deepEqual(outcome.selfDescription.serverInfo, {
    name: "Notion MCP",
    version: "1.8.1",
    description: "d".repeat(MCP_STDIO_LIMITS.stringChars),
    websiteUrl: "https://notion.so",
    icons: [
      {
        src: "https://notion.so/icon.png",
        mimeType: "image/png",
        sizes: ["48x48"],
      },
    ],
  });
  assert.equal(
    outcome.selfDescription.instructions?.length,
    MCP_STDIO_LIMITS.instructionsChars,
  );
  assert.deepEqual(outcome.selfDescription.capabilities, {
    tools: { listChanged: false },
  });
  assert.deepEqual(
    outcome.tools.map((tool) => tool.name),
    ["search", "create"],
  );
  assert.equal(
    outcome.tools[0]?.description?.length,
    MCP_STDIO_LIMITS.toolDescriptionChars,
  );
  assert.deepEqual(outcome.tools[0]?.inputSchema, { type: "object" });
  assert.equal(outcome.tools[0]?.risk, "unknown");
  assert.deepEqual(outcome.tools[1]?.annotations, { readOnlyHint: false });
});

test("tools are capped at the limit; oversized capabilities are dropped", () => {
  const result = parseStdioDriverResult(
    JSON.stringify({
      ok: true,
      tools: Array.from({ length: 250 }, (_, i) => ({ name: `t${i}` })),
      capabilities: { big: "x".repeat(5000) },
      timings: {},
      stderrTail: "",
    }),
  );
  assert.ok(result);
  const outcome = stdioValidationOutcome(result, NOW);
  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.tools.length, MCP_STDIO_LIMITS.tools);
  assert.equal(outcome.selfDescription.capabilities, undefined);
  assert.equal(outcome.selfDescription.serverInfo, undefined);
});

test("a failure becomes the validation record with a bounded detail", () => {
  const result = parseStdioDriverResult(
    JSON.stringify({
      ok: false,
      reason: "install",
      detail: "e".repeat(800),
      exitCode: 1,
      timings: { installMs: 90000, startMs: 0 },
      stderrTail: "npm ERR!",
    }),
  );
  assert.ok(result);
  const outcome = stdioValidationOutcome(result, NOW);
  assert.deepEqual(outcome, {
    kind: "failure",
    validation: {
      status: "failed",
      reason: "install",
      at: NOW.toISOString(),
      detail: "e".repeat(MCP_STDIO_LIMITS.detailChars),
    },
  });
});

test("every driver failure reason maps to the contract's", () => {
  for (const reason of ["install", "start", "protocol", "timeout"] as const) {
    const result = parseStdioDriverResult(
      JSON.stringify({
        ok: false,
        reason,
        detail: "",
        timings: {},
        stderrTail: "",
      }),
    );
    assert.ok(result);
    const outcome = stdioValidationOutcome(result, NOW);
    assert.equal(outcome.kind, "failure");
    if (outcome.kind !== "failure") return;
    assert.equal(outcome.validation.reason, reason);
    assert.equal(outcome.validation.detail, undefined);
  }
});

test("an unsupported package is recorded as such", () => {
  assert.deepEqual(unsupportedValidation("No stdio package to run", NOW), {
    status: "unsupported",
    reason: "unsupported-package",
    at: NOW.toISOString(),
    detail: "No stdio package to run",
  });
});
