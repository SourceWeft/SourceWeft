import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeTraceParts,
  tracePartFromToolCall,
  upsertTracePart,
} from "./trace-parts";
import type { ToolCallTrace } from "./types";

const largeOutput = {
  type: "tool_result",
  content: "x".repeat(100 * 1024),
};

const toolCall: ToolCallTrace = {
  id: "search-1",
  tool: "search_sources",
  mcpDisplay: { serverName: "notion", toolName: "search" },
  input: { query: "Q1 revenue" },
  output: largeOutput,
  status: "completed",
  latencyMs: 1234,
  error: null,
  sequence: 3,
  approvalState: "approved",
  approvalConfirmationId: "confirmation-1",
};

test("tool trace parts carry structure, never the tool output", () => {
  const part = tracePartFromToolCall(toolCall);
  assert.equal(part.kind, "tool");
  assert.ok(!("output" in part), "trace part must not copy tool output");
  assert.ok(
    JSON.stringify(part).length < 1024,
    `trace part for a 100 KB output must stay under 1 KB, got ${JSON.stringify(part).length}`,
  );
  assert.deepEqual(part, {
    kind: "tool",
    id: "search-1",
    toolCallId: "search-1",
    tool: "search_sources",
    mcpDisplay: { serverName: "notion", toolName: "search" },
    status: "completed",
    input: { query: "Q1 revenue" },
    error: null,
    latencyMs: 1234,
    approvalState: "approved",
    approvalConfirmationId: "confirmation-1",
  });
});

test("legacy persisted tool trace parts drop their output on normalization", () => {
  const legacy = {
    id: "search-1",
    kind: "tool",
    order: 0,
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    toolCallId: "search-1",
    tool: "search_sources",
    input: { query: "Q1 revenue" },
    output: largeOutput,
    status: "completed",
    latencyMs: 1234,
    error: null,
  };
  const [normalized] = normalizeTraceParts([legacy]);
  assert.ok(normalized);
  assert.ok(!("output" in normalized));
  assert.equal(normalized.kind, "tool");
  assert.equal(
    normalized.kind === "tool" ? normalized.status : null,
    "completed",
  );

  const upserted = upsertTracePart(
    [legacy],
    tracePartFromToolCall({ ...toolCall, status: "error", error: "boom" }),
  );
  assert.equal(upserted.length, 1);
  assert.ok(!("output" in upserted[0]!));
  assert.equal(
    upserted[0]!.kind === "tool" ? upserted[0]!.error : null,
    "boom",
  );
  assert.ok(JSON.stringify(upserted).length < 1024);
});
