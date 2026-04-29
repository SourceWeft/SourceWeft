import assert from "node:assert/strict";
import test from "node:test";
import { mapDeepAgentEventToSse, normalizeToolOutputForSse } from "./event-mapper";
import type { DeepAgentTurnEvent } from "../../agent/turn/runner";

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<string, unknown>;
}

test("normalizeToolOutputForSse renders file listings as display content", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({
      files: [
        { path: "/kb/invoice.md", is_dir: false, size: 83466 },
        { path: "/kb/invoice/", is_dir: true },
      ],
    }),
    {
      content: "/kb/invoice.md (83466 bytes)\n/kb/invoice/ (directory)",
    },
  );
});

test("normalizeToolOutputForSse renders grep matches as display content", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({
      matches: [
        { path: "/kb/invoice/chunks/0000.md", line: 12, text: "Invoice No. 123" },
      ],
    }),
    {
      content: "/kb/invoice/chunks/0000.md:12: Invoice No. 123",
    },
  );
});

test("normalizeToolOutputForSse preserves readable content outputs", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({ content: "Path: /kb/invoice.md\nSource: Invoice" }),
    { content: "Path: /kb/invoice.md\nSource: Invoice" },
  );
});

test("normalizeToolOutputForSse extracts ToolMessage content", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({
      id: ["langchain_core", "messages", "tool", "ToolMessage"],
      kwargs: {
        content: [{ text: "tool output" }],
        name: "ls",
        status: "success",
      },
    }),
    { content: "tool output", name: "ls", status: "success" },
  );
});

test("mapDeepAgentEventToSse sends displayable tool result output", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "tool-call-result",
    id: "ls-1",
    tool: "ls",
    input: { path: "/kb" },
    output: {
      files: [{ path: "/kb/invoice.md", is_dir: false, size: 83466 }],
    },
    latencyMs: 31,
    toolCall: {
      id: "ls-1",
      tool: "ls",
      input: { path: "/kb" },
      output: {
        files: [{ path: "/kb/invoice.md", is_dir: false, size: 83466 }],
      },
      status: "completed",
      latencyMs: 31,
      error: null,
      sequence: 1,
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.deepEqual(data.output, { content: "/kb/invoice.md (83466 bytes)" });
  assert.deepEqual(
    (data.toolCall as { output: unknown }).output,
    { content: "/kb/invoice.md (83466 bytes)" },
  );
});
