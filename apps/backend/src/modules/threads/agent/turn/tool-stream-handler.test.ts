import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import { test, vi } from "vitest";
import { logger } from "../../../../shared/logger";
import {
  collectToolStreamEvents,
  createToolLoggingPreparedTurn,
} from "../../../../test/turn-stream-collectors";
import {
  handleToolEndStreamChunk,
  handleToolErrorStreamChunk,
  handleToolStartStreamChunk,
} from "./tool-stream-handler";
import { resolveToolsStreamToolCall } from "./tool-tracker";
import { createTurnRuntime } from "./turn-runtime";
import { adaptToolsEvent } from "./v3-protocol";

for (const error of [
  "[AGENT_TOOL_EXECUTION_TIMEOUT] Tool 'validate_video_presentation' timed out after 600000ms. The call did not produce a successful result.",
  "[AGENT_TOOL_TERMINATION_UNKNOWN] Tool 'validate_video_presentation' did not confirm termination within 30000ms. Do not treat this call as successful or reuse its execution environment.",
]) {
  test(`serialized error ToolMessage projects ${error.split("]")[0]}] to live and collected error state`, async () => {
    const prepared = createToolLoggingPreparedTurn();
    const runtime = createTurnRuntime({ prepared });
    const toolNameByCallId = new Map<string, string>();
    const callId = "call-timeout-projection";
    const toolName = "validate_video_presentation";
    const startPayload = adaptToolsEvent(
      {
        event: "tool-started",
        tool_call_id: callId,
        tool_name: toolName,
        input: "{}",
      },
      toolNameByCallId,
    );
    assert.ok(startPayload);
    const startSnapshot = resolveToolsStreamToolCall({
      payload: startPayload,
      resolveToolCallSequence: runtime.resolveToolCallSequence,
      toolCallOrder: runtime.toolCallOrder,
      toolCallsById: runtime.toolCallsById,
    });
    assert.ok(startSnapshot);
    await collectToolStreamEvents(
      handleToolStartStreamChunk({
        prepared,
        runtime,
        snapshot: startSnapshot,
      }),
    );

    const message = new ToolMessage({
      content: error,
      name: toolName,
      status: "error",
      tool_call_id: callId,
    });
    const finishPayload = adaptToolsEvent(
      {
        event: "tool-finished",
        tool_call_id: callId,
        output: message.toJSON(),
      },
      toolNameByCallId,
    );
    assert.ok(finishPayload);
    const errorSnapshot = resolveToolsStreamToolCall({
      payload: finishPayload,
      resolveToolCallSequence: runtime.resolveToolCallSequence,
      toolCallOrder: runtime.toolCallOrder,
      toolCallsById: runtime.toolCallsById,
    });
    assert.ok(errorSnapshot);
    const liveEvents = await collectToolStreamEvents(
      handleToolErrorStreamChunk({
        prepared,
        runtime,
        snapshot: errorSnapshot,
      }),
    );

    assert.deepEqual(
      liveEvents.map((event) => event.type),
      ["tool-call-error", "tool-call-end"],
    );
    assert.equal(
      liveEvents[0]?.type === "tool-call-error"
        ? liveEvents[0].toolCall.status
        : null,
      "error",
    );
    assert.equal(runtime.toolCallsById.get(callId)?.status, "error");
    assert.equal(runtime.toolCallsById.get(callId)?.error, error);
    assert.equal(runtime.collectToolCalls()[0]?.status, "error");
    assert.equal(runtime.collectToolCalls()[0]?.error, error);
  });
}

test("tool stream handler leaves generic tool logging to middleware", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  try {
    const currentToolCall = {
      id: "call-pptx",
      tool: "publish_artifact",
      input: {},
      output: null,
      status: "running" as const,
      latencyMs: null,
      error: null,
      sequence: 1,
    };

    await collectToolStreamEvents(
      handleToolStartStreamChunk({
        prepared,
        runtime,
        snapshot: {
          currentToolCall,
          event: "on_tool_start",
          normalizedInput: {
            title: "Quarterly update",
            source_content: "raw source content must not be logged",
          },
          toolCallId: "call-pptx",
          toolName: "publish_artifact",
          toolPayload: {},
        },
      }),
    );
    await collectToolStreamEvents(
      handleToolEndStreamChunk({
        prepared,
        runtime,
        snapshot: {
          currentToolCall:
            runtime.toolCallsById.get("call-pptx") ?? currentToolCall,
          event: "on_tool_end",
          normalizedInput: { title: "Quarterly update" },
          toolCallId: "call-pptx",
          toolName: "publish_artifact",
          toolPayload: {
            output: {
              artifactId: "artifact-1",
              artifactUrl: "https://example.test/artifact-1.pptx",
            },
          },
        },
      }),
    );

    assert.equal(
      infoSpy.mock.calls.some((call) =>
        String(call[0]).startsWith("agent.tool."),
      ),
      false,
    );
  } finally {
    infoSpy.mockRestore();
  }
});

test("tool stream handler attaches persisted sandbox operations on completion", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const currentToolCall = {
    id: "call-sandbox-execute",
    tool: "execute",
    input: { command: "printf done" },
    output: null,
    status: "running" as const,
    latencyMs: null,
    error: null,
    sequence: 1,
  };
  const operations = [
    {
      operationType: "execute",
      status: "succeeded",
      durationMs: 12,
      createdAt: "2026-08-16T08:00:00.000Z",
      result: { exitCode: 0, outputChars: 4 },
    },
  ];
  const getSandboxOperationTimeline = vi.fn(async () => operations);

  const events = await collectToolStreamEvents(
    handleToolEndStreamChunk({
      prepared,
      runtime,
      getSandboxOperationTimeline,
      snapshot: {
        currentToolCall,
        event: "on_tool_end",
        normalizedInput: currentToolCall.input,
        toolCallId: currentToolCall.id,
        toolName: currentToolCall.tool,
        toolPayload: {
          output: { exitCode: 0, output: "done", truncated: false },
        },
      },
    }),
  );

  assert.equal(getSandboxOperationTimeline.mock.calls.length, 1);
  const resultEvent = events.find((event) => event.type === "tool-call-result");
  const endEvent = events.find((event) => event.type === "tool-call-end");
  const expectedOutput = {
    exitCode: 0,
    output: "done",
    truncated: false,
    operations,
  };
  assert.deepEqual(
    resultEvent?.type === "tool-call-result" ? resultEvent.output : null,
    expectedOutput,
  );
  assert.deepEqual(
    endEvent?.type === "tool-call-end" ? endEvent.toolCall.output : null,
    expectedOutput,
  );
});

test("tool stream handler attaches persisted sandbox operations on errors", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const currentToolCall = {
    id: "call-sandbox-error",
    tool: "execute",
    input: { command: "false" },
    output: null,
    status: "running" as const,
    latencyMs: null,
    error: null,
    sequence: 1,
  };
  const operations = [
    {
      operationType: "execute",
      status: "failed",
      durationMs: 8,
      createdAt: "2026-08-16T08:00:00.000Z",
      result: {},
    },
  ];

  const events = await collectToolStreamEvents(
    handleToolErrorStreamChunk({
      prepared,
      runtime,
      getSandboxOperationTimeline: async () => operations,
      snapshot: {
        currentToolCall,
        event: "on_tool_error",
        normalizedInput: currentToolCall.input,
        toolCallId: currentToolCall.id,
        toolName: currentToolCall.tool,
        toolPayload: { error: new Error("sandbox command failed") },
      },
    }),
  );

  const errorEvent = events.find((event) => event.type === "tool-call-error");
  assert.deepEqual(
    errorEvent?.type === "tool-call-error" ? errorEvent.toolCall.output : null,
    { content: null, operations },
  );
});

test("skill instruction read stream labels use selected skill display name", async () => {
  const prepared = {
    ...createToolLoggingPreparedTurn(),
    enabledSkills: [
      {
        name: "ppt-deck",
        displayName: "PPT Deck",
      },
    ],
  } as never;
  const runtime = createTurnRuntime({ prepared });
  const currentToolCall = {
    id: "call-skill-read",
    tool: "read_file",
    input: {},
    output: null,
    status: "running" as const,
    latencyMs: null,
    error: null,
    sequence: 1,
  };

  const startEvents = await collectToolStreamEvents(
    handleToolStartStreamChunk({
      prepared,
      runtime,
      snapshot: {
        currentToolCall,
        event: "on_tool_start",
        normalizedInput: {
          file_path: "/skills/ppt-deck/SKILL.md",
        },
        toolCallId: "call-skill-read",
        toolName: "read_file",
        toolPayload: {},
      },
    }),
  );
  const startToolCall = startEvents.find(
    (event) => event.type === "tool-call-start",
  );
  const startStep = startEvents.find((event) => event.type === "thinking-step");

  assert.deepEqual(
    startToolCall?.type === "tool-call-start" ? startToolCall.input : null,
    {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "PPT Deck",
      skillFileName: "SKILL.md",
      skillPath: "/skills/ppt-deck/SKILL.md",
      skillSlug: "ppt-deck",
      visibility: "internal_instruction",
    },
  );
  assert.equal(
    startStep?.type === "thinking-step" ? startStep.step.title : null,
    "Loading PPT Deck skill instructions",
  );

  const endEvents = await collectToolStreamEvents(
    handleToolEndStreamChunk({
      prepared,
      runtime,
      snapshot: {
        currentToolCall:
          runtime.toolCallsById.get("call-skill-read") ?? currentToolCall,
        event: "on_tool_end",
        normalizedInput: {
          file_path: "/skills/ppt-deck/SKILL.md",
        },
        toolCallId: "call-skill-read",
        toolName: "read_file",
        toolPayload: {
          output: { content: "name: ppt-deck\ninternal guidance" },
        },
      },
    }),
  );
  const resultEvent = endEvents.find(
    (event) => event.type === "tool-call-result",
  );
  const endToolCall = endEvents.find((event) => event.type === "tool-call-end");
  const endStep = endEvents.find((event) => event.type === "thinking-step");

  assert.deepEqual(
    resultEvent?.type === "tool-call-result" ? resultEvent.output : null,
    {
      type: "skill_instruction_read",
      redacted: true,
      skillFileName: "SKILL.md",
      skillPath: "/skills/ppt-deck/SKILL.md",
    },
  );
  assert.deepEqual(
    endToolCall?.type === "tool-call-end" ? endToolCall.toolCall.input : null,
    {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "PPT Deck",
      skillFileName: "SKILL.md",
      skillPath: "/skills/ppt-deck/SKILL.md",
      skillSlug: "ppt-deck",
      visibility: "internal_instruction",
    },
  );
  assert.deepEqual(
    endToolCall?.type === "tool-call-end" ? endToolCall.toolCall.output : null,
    {
      type: "skill_instruction_read",
      redacted: true,
      skillFileName: "SKILL.md",
      skillPath: "/skills/ppt-deck/SKILL.md",
    },
  );
  assert.equal(
    endStep?.type === "thinking-step" ? endStep.step.title : null,
    "Load PPT Deck skill instructions",
  );
});

test("file completion keeps its tracked physical scope when the end event omits input", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const currentToolCall = {
    id: "physical-read",
    tool: "read_file",
    input: { file_path: "/Users/test/project/report.txt" },
    output: null,
    status: "running" as const,
    latencyMs: null,
    error: null,
    sequence: 1,
  };
  const events = await collectToolStreamEvents(
    handleToolEndStreamChunk({
      prepared,
      runtime,
      snapshot: {
        currentToolCall,
        event: "on_tool_end",
        normalizedInput: {},
        toolCallId: currentToolCall.id,
        toolName: currentToolCall.tool,
        toolPayload: { output: { content: "disk text" } },
      },
    }),
  );
  const step = events.find((event) => event.type === "thinking-step");
  assert.equal(
    step?.type === "thinking-step" ? step.step.metadata?.filesystemScope : null,
    "files",
  );
  assert.equal(
    step?.type === "thinking-step" ? step.step.title : null,
    "Read file",
  );
});
