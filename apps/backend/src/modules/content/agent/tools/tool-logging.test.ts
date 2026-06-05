import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { logger } from "../../../../shared/logger";
import {
  AGENT_TOOL_LOG_EVENTS,
  logAgentToolEvent,
  sanitizeAgentToolLogMetadata,
} from "./tool-logging";

afterEach(() => {
  vi.restoreAllMocks();
});

test("exports stable agent tool log event names", () => {
  assert.deepEqual(AGENT_TOOL_LOG_EVENTS, {
    started: "agent.tool.started",
    completed: "agent.tool.completed",
    failed: "agent.tool.failed",
    stageStarted: "agent.tool.stage.started",
    stageCompleted: "agent.tool.stage.completed",
    stageFailed: "agent.tool.stage.failed",
    enqueued: "agent.tool.enqueued",
    workerStarted: "agent.tool.worker.started",
    workerCompleted: "agent.tool.worker.completed",
    workerFailed: "agent.tool.worker.failed",
    workerStageStarted: "agent.tool.worker.stage.started",
    workerStageCompleted: "agent.tool.worker.stage.completed",
    workerStageFailed: "agent.tool.worker.stage.failed",
  });
});

test("sanitizes metadata by allowlist and drops unsafe fields", () => {
  const sanitized = sanitizeAgentToolLogMetadata(
    AGENT_TOOL_LOG_EVENTS.started,
    {
      toolName: "generate_pptx",
      toolCallId: "call-1",
      threadId: "thread-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      userId: "user-1",
      durationMs: 42,
      counts: { slides: 8, invalid: Number.NaN, nested: { value: 1 } },
      error: new Error("should not be present for started"),
      prompt: "raw user prompt",
      source_content: "raw source content",
      authorization: "Bearer secret",
    } as Record<string, unknown>,
  );

  assert.deepEqual(sanitized, {
    event: "agent.tool.started",
    toolName: "generate_pptx",
    toolCallId: "call-1",
    threadId: "thread-1",
    userMessageId: "message-1",
    workspaceId: "workspace-1",
    teamId: "team-1",
    userId: "user-1",
    durationMs: 42,
    counts: { slides: 8 },
    error: { name: "Error", message: "Tool execution failed." },
  });
  assert.equal("prompt" in sanitized, false);
  assert.equal("source_content" in sanitized, false);
  assert.equal("authorization" in sanitized, false);
});

test("normalizes errors without stack traces or raw messages", () => {
  const error = new Error("provider request failed with token=secret-token");
  error.stack = "secret stack";
  Object.assign(error, {
    code: "PROVIDER_FAILED",
    category: "provider",
    retryable: true,
    responseBody: "secret body",
  });

  const sanitized = sanitizeAgentToolLogMetadata(AGENT_TOOL_LOG_EVENTS.failed, {
    toolName: "generate_video_presentation",
    error,
  });

  assert.deepEqual(sanitized, {
    event: "agent.tool.failed",
    toolName: "generate_video_presentation",
    error: {
      name: "Error",
      code: "PROVIDER_FAILED",
      category: "provider",
      message: "Tool execution failed.",
      retryable: true,
    },
  });
});

test("truncates unbounded string fields without preserving raw error text", () => {
  const sanitized = sanitizeAgentToolLogMetadata(AGENT_TOOL_LOG_EVENTS.completed, {
    toolName: "x".repeat(300),
    error: `secret=${"e".repeat(600)}`,
  });

  assert.equal(typeof sanitized.toolName, "string");
  assert.equal((sanitized.toolName as string).length, 243);
  assert.match(sanitized.toolName as string, /\.\.\.$/);
  const error = sanitized.error as { message: string };
  assert.equal(error.message, "Tool execution failed.");
});

test("does not leak serialized provider error payloads", () => {
  const sanitized = sanitizeAgentToolLogMetadata(AGENT_TOOL_LOG_EVENTS.failed, {
    error: {
      message: "request body contained prompt and token",
      responseBody: "token=secret source_content=private",
      stack: "secret stack",
    },
  });

  assert.deepEqual(sanitized, {
    event: "agent.tool.failed",
    error: { message: "Tool execution failed." },
  });
});

test("logs through the shared logger with sanitized metadata", () => {
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);

  logAgentToolEvent("info", AGENT_TOOL_LOG_EVENTS.started, {
    toolName: "search_sources",
    toolCallId: "call-1",
    secret: "not logged",
  } as Record<string, unknown>);

  assert.equal(infoSpy.mock.calls.length, 1);
  assert.equal(infoSpy.mock.calls[0]?.[0], "agent.tool.started");
  assert.deepEqual(infoSpy.mock.calls[0]?.[1], {
    event: "agent.tool.started",
    toolName: "search_sources",
    toolCallId: "call-1",
  });
});

test("logger arguments do not include raw error secrets", () => {
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

  logAgentToolEvent("error", AGENT_TOOL_LOG_EVENTS.failed, {
    toolName: "generate_video_presentation",
    error: new Error("token=secret-token source_content=private prompt=raw"),
  });

  assert.equal(errorSpy.mock.calls.length, 1);
  const serialized = JSON.stringify(errorSpy.mock.calls[0]);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("source_content=private"), false);
  assert.equal(serialized.includes("prompt=raw"), false);
  assert.match(serialized, /Tool execution failed\./);
});

test("suppresses logger failures", () => {
  vi.spyOn(logger, "error").mockImplementation(() => {
    throw new Error("stdout unavailable");
  });

  assert.doesNotThrow(() => {
    logAgentToolEvent("error", AGENT_TOOL_LOG_EVENTS.failed, {
      toolName: "generate_pptx",
      error: new Error("tool failed"),
    });
  });
});
