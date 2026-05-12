import assert from "node:assert/strict";
import test from "node:test";
import {
  mapDeepAgentEventToSse,
  normalizeToolOutputForSse,
} from "./event-mapper";
import type { DeepAgentTurnEvent } from "../../agent/turn/runner";

function parseSseData(value: string) {
  assert.equal(value.startsWith("data: "), true);
  return JSON.parse(value.slice("data: ".length).trim()) as Record<
    string,
    unknown
  >;
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
        {
          path: "/kb/invoice/chunks/0000.md",
          line: 12,
          text: "Invoice No. 123",
        },
      ],
    }),
    {
      content: "/kb/invoice/chunks/0000.md:12: Invoice No. 123",
    },
  );
});

test("normalizeToolOutputForSse preserves readable content outputs", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({
      content: "Path: /kb/invoice.md\nSource: Invoice",
    }),
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
  assert.deepEqual((data.toolCall as { output: unknown }).output, {
    content: "/kb/invoice.md (83466 bytes)",
  });
});

test("mapDeepAgentEventToSse sends slim tool progress events", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "tool-call-event",
    id: "image-1",
    tool: "generate_image",
    data: {
      type: "generate_image_progress",
      toolCallId: "image-1",
      stage: "generating",
      title: "Concept map",
    },
    toolCall: {
      id: "image-1",
      tool: "generate_image",
      input: { prompt: "long prompt", title: "Concept map" },
      output: { stage: "generating" },
      status: "running",
      latencyMs: null,
      error: null,
      sequence: 1,
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.equal(data.type, "tool-call-event");
  assert.equal(data.id, "image-1");
  assert.deepEqual(data.data, event.data);
  assert.equal("toolCall" in data, false);
});

test("mapDeepAgentEventToSse sends slim tool end events", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "tool-call-end",
    id: "image-1",
    tool: "generate_image",
    status: "completed",
    latencyMs: 1234,
    toolCall: {
      id: "image-1",
      tool: "generate_image",
      input: { prompt: "long prompt", title: "Concept map" },
      output: { artifactUrl: "/artifact.png" },
      status: "completed",
      latencyMs: 1234,
      error: null,
      sequence: 1,
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.deepEqual(data, {
    type: "tool-call-end",
    id: "image-1",
    tool: "generate_image",
    status: "completed",
    latencyMs: 1234,
  });
});

test("mapDeepAgentEventToSse preserves tool input parameters", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "tool-call-start",
    id: "grep-1",
    tool: "grep",
    input: { pattern: "DESCRIPTION", path: "/kb" },
    toolCall: {
      id: "grep-1",
      tool: "grep",
      input: { pattern: "DESCRIPTION", path: "/kb" },
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence: 1,
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.deepEqual(data.input, { pattern: "DESCRIPTION", path: "/kb" });
  assert.deepEqual((data.toolCall as { input: unknown }).input, {
    pattern: "DESCRIPTION",
    path: "/kb",
  });
});

test("mapDeepAgentEventToSse maps text interruption events", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "text-interrupted",
    reason: "tool-call",
    toolCallId: "tool-1",
    tool: "search_sources",
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.equal(data.type, "text-interrupted");
  assert.equal(data.id, "text-1");
  assert.equal(data.reason, "tool-call");
  assert.equal(data.toolCallId, "tool-1");
  assert.equal(data.tool, "search_sources");
});

test("mapDeepAgentEventToSse maps text replacement events", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "text-replace",
    text: "Final markdown\n\n![Generated](/artifact.png)",
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.equal(data.type, "text-replace");
  assert.equal(data.id, "text-1");
  assert.equal(data.text, "Final markdown\n\n![Generated](/artifact.png)");
});
