import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mapDeepAgentEventToSse,
  normalizeToolOutputForSse,
} from "./event-mapper";
import type { DeepAgentTurnEvent } from "../agent/turn/runner";

function parseSseData(value: string | null) {
  assert.notEqual(value, null);
  assert.equal(value!.startsWith("data: "), true);
  return JSON.parse(value!.slice("data: ".length).trim()) as Record<
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

test("normalizeToolOutputForSse preserves redacted skill instruction reads", () => {
  assert.deepEqual(
    normalizeToolOutputForSse({
      type: "skill_instruction_read",
      redacted: true,
      content: "name: feynman\ninternal instructions",
    }),
    {
      type: "skill_instruction_read",
      redacted: true,
    },
  );
});

test("normalizeToolOutputForSse preserves structured confirmation payloads", () => {
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "notion.page.create",
      toolName: "create_notion_page",
      label: "Create",
      riskLevel: "low",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create Notion page",
      requestJson: {
        title: "Draft",
      },
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "connector-1",
        actionRunId: "action-1",
      },
    },
    status: "proposed",
    userMessage: "This action is waiting for confirmation in SourceWeft.",
  };

  assert.deepEqual(
    normalizeToolOutputForSse(confirmation),
    confirmation,
  );
});

test("normalizeToolOutputForSse preserves structured askUser question payloads", () => {
  const question = {
    type: "user_question_request",
    schemaVersion: 1,
    id: "askq:ckpt-1:call_1",
    toolCallId: "call_1",
    questions: [
      {
        question: "Which format?",
        type: "multiple_choice",
        choices: [{ label: "PDF" }, { label: "Slides" }],
      },
    ],
  };

  assert.deepEqual(normalizeToolOutputForSse(question), question);
});

test("normalizeToolOutputForSse preserves structured video presentation outputs", () => {
  const structured = {
    type: "video_presentation_processing_result",
    artifact_id: "artifact-1",
    status: "running",
    content: "Video presentation project is still being generated.",
  };

  assert.deepEqual(normalizeToolOutputForSse(structured), structured);
  assert.deepEqual(
    normalizeToolOutputForSse({ content: JSON.stringify(structured) }),
    structured,
  );
  assert.deepEqual(
    normalizeToolOutputForSse(JSON.stringify(structured)),
    structured,
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

test("mapDeepAgentEventToSse sends stable tool progress payloads", () => {
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
  assert.deepEqual(data.toolCall, event.toolCall);
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
  });
});

test("mapDeepAgentEventToSse preserves approval requested tool end events", () => {
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: {
      label: "Notion",
      provider: "notion",
      connectorId: "connector-1",
    },
    action: {
      type: "notion.page.trash",
      toolName: "delete_notion_page",
      label: "Delete",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Delete Notion page",
    },
    decisionOptions: [
      { decision: "reject", label: "Reject" },
      { decision: "approve", label: "Approve" },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "connector_action_run",
        connectorId: "connector-1",
        actionRunId: "action-1",
      },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  };
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "tool-call-end",
    id: "tool-1",
    tool: "delete_notion_page",
    status: "approval_requested",
    latencyMs: 0,
    toolCall: {
      id: "tool-1",
      tool: "delete_notion_page",
      input: {},
      output: confirmation,
      status: "approval_requested",
      latencyMs: 0,
      error: null,
      sequence: 1,
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.equal(data.status, "approval_requested");
  assert.deepEqual(data.toolCall, event.toolCall);
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

test("mapDeepAgentEventToSse sends delta-only reasoning segment metadata", () => {
  const event: Exclude<DeepAgentTurnEvent, { type: "done" }> = {
    type: "reasoning",
    reasoning: " PowerPoint",
    segment: {
      id: "model-reasoning:run-1:1",
      text: "The user wants me to create a PowerPoint",
      sequence: 1,
      durationMs: 4649,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_sources",
    },
  };

  const data = parseSseData(mapDeepAgentEventToSse(event, "text-1"));

  assert.deepEqual(data, {
    type: "reasoning",
    reasoning: " PowerPoint",
    segment: {
      id: "model-reasoning:run-1:1",
      sequence: 1,
      durationMs: 4649,
      phase: "after_tool",
      toolCallId: "tool-1",
      tool: "search_sources",
    },
  });
  assert.equal(
    Object.hasOwn(data.segment as Record<string, unknown>, "text"),
    false,
  );
});

test("mapDeepAgentEventToSse still maps citations events", () => {
  const event: DeepAgentTurnEvent = {
    type: "citations",
    citations: [],
    availableCitations: [],
  } as DeepAgentTurnEvent;
  const data = parseSseData(mapDeepAgentEventToSse(event as never, "text-1"));
  assert.equal(data.type, "citations");
});

test("mapDeepAgentEventToSse returns null for an unrecognized event type", () => {
  // A future variant (e.g. sub-agent activity) must NOT fall through to the
  // citations branch; it produces no SSE frame so callers can skip it.
  const result = mapDeepAgentEventToSse(
    { type: "subagent-activity" } as never,
    "text-1",
  );
  assert.equal(result, null);
});
