import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { testExports as agentTestExports } from "..";
import {
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./runner";
import { commandExecutionPolicyFor } from "./command-success";
import { ContentError } from "../../errors";
import { logger } from "../../../../shared/logger";
import { mcpService } from "../../../mcp";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import { handleCustomStreamChunk } from "./custom-stream-handler";
import {
  handleHitlStreamChunk,
  type HitlStreamHandlerResult,
} from "./hitl-stream-handler";
import { handleMessagesStreamChunk } from "./message-stream-handler";
import {
  handleToolEndStreamChunk,
  handleToolErrorStreamChunk,
  handleToolStartStreamChunk,
} from "./tool-stream-handler";
import { normalizeToolOutputForObservability } from "./output-normalizer";
import { testExports } from "./runner";
import { createTurnRuntime } from "./turn-runtime";
import type { DeepAgentTurnEvent } from "./events";
import type { ConnectorActionExecutionCursor } from "../../../connectors/agent-tool-idempotency";

async function collectMessageStreamEvents(
  input: Parameters<typeof handleMessagesStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of handleMessagesStreamChunk(input)) {
    events.push(event);
  }
  return events;
}

async function collectCustomStreamEvents(
  input: Parameters<typeof handleCustomStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of handleCustomStreamChunk(input)) {
    events.push(event);
  }
  return events;
}

async function collectHitlStreamResult(
  input: Parameters<typeof handleHitlStreamChunk>[0],
) {
  const events: DeepAgentTurnEvent[] = [];
  const generator = handleHitlStreamChunk(input);
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return {
        events,
        result: next.value as HitlStreamHandlerResult,
      };
    }
    events.push(next.value);
  }
}

function toolNames(tools: readonly unknown[]) {
  return tools.map((tool) => {
    const name =
      tool && typeof tool === "object" && !Array.isArray(tool)
        ? (tool as { name?: unknown }).name
        : undefined;
    if (typeof name !== "string") {
      throw new Error("Expected test tool to have a string name");
    }
    return name;
  });
}

async function* emptyAgentStream() {}

function createToolLoggingPreparedTurn() {
  return {
    runTraceId: "trace-tool-logging",
    thread: { id: "thread-1" },
    userMessage: { id: "message-1" },
    workspace: { id: "workspace-1", organizationId: "team-1" },
    userId: "user-1",
  } as never;
}

async function collectToolStreamEvents(
  generator: AsyncGenerator<DeepAgentTurnEvent>,
) {
  const events: DeepAgentTurnEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

test("generic tool stream logging emits PPTX start and completed lifecycle events", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  try {
    const currentToolCall = {
      id: "call-pptx",
      tool: "generate_pptx",
      input: {},
      output: null,
      status: "running" as const,
      latencyMs: null,
      error: null,
      sequence: 1,
    };

    await collectToolStreamEvents(
      handleToolStartStreamChunk({
        artifactIntent: undefined as never,
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
          toolName: "generate_pptx",
          toolPayload: {},
        },
      }),
    );
    await collectToolStreamEvents(
      handleToolEndStreamChunk({
        prepared,
        runtime,
        snapshot: {
          currentToolCall: runtime.toolCallsById.get("call-pptx") ?? currentToolCall,
          event: "on_tool_end",
          normalizedInput: { title: "Quarterly update" },
          toolCallId: "call-pptx",
          toolName: "generate_pptx",
          toolPayload: {
            output: {
              artifactId: "artifact-1",
              artifactUrl: "https://example.test/artifact-1.pptx",
            },
          },
        },
      }),
    );

    assert.equal(infoSpy.mock.calls.length, 2);
    assert.equal(infoSpy.mock.calls[0]?.[0], "agent.tool.started");
    assert.equal(infoSpy.mock.calls[1]?.[0], "agent.tool.completed");
    assert.deepEqual(infoSpy.mock.calls[0]?.[1], {
      event: "agent.tool.started",
      toolName: "generate_pptx",
      toolCallId: "call-pptx",
      threadId: "thread-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      userId: "user-1",
      status: "running",
    });
    const completed = infoSpy.mock.calls[1]?.[1] as Record<string, unknown>;
    assert.equal(completed.event, "agent.tool.completed");
    assert.equal(completed.toolName, "generate_pptx");
    assert.equal(completed.toolCallId, "call-pptx");
    assert.equal(completed.status, "completed");
    assert.equal(typeof completed.durationMs, "number");
    assert.equal("source_content" in completed, false);
  } finally {
    infoSpy.mockRestore();
  }
});

test("generic tool stream logging emits video failed lifecycle event", async () => {
  const prepared = createToolLoggingPreparedTurn();
  const runtime = createTurnRuntime({ prepared });
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  try {
    const currentToolCall = {
      id: "call-video",
      tool: "generate_video_presentation",
      input: {},
      output: null,
      status: "running" as const,
      latencyMs: null,
      error: null,
      sequence: 1,
    };

    await collectToolStreamEvents(
      handleToolStartStreamChunk({
        artifactIntent: undefined as never,
        prepared,
        runtime,
        snapshot: {
          currentToolCall,
          event: "on_tool_start",
          normalizedInput: {
            video_title: "Training video",
            source_content: "raw video source must not be logged",
          },
          toolCallId: "call-video",
          toolName: "generate_video_presentation",
          toolPayload: {},
        },
      }),
    );
    await collectToolStreamEvents(
      handleToolErrorStreamChunk({
        prepared,
        runtime,
        snapshot: {
          currentToolCall: runtime.toolCallsById.get("call-video") ?? currentToolCall,
          event: "on_tool_error",
          normalizedInput: {},
          toolCallId: "call-video",
          toolName: "generate_video_presentation",
          toolPayload: { error: new Error("video enqueue failed") },
        },
      }),
    );

    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal(errorSpy.mock.calls[0]?.[0], "agent.tool.failed");
    const failed = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(typeof failed.durationMs, "number");
    assert.deepEqual(failed, {
      event: "agent.tool.failed",
      toolName: "generate_video_presentation",
      toolCallId: "call-video",
      threadId: "thread-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      userId: "user-1",
      status: "error",
      durationMs: failed.durationMs,
      error: { message: "Tool execution failed." },
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test("normalizes read_file ToolMessage output content for observability", () => {
  const output = normalizeToolOutputForObservability("read_file", {
    type: "tool",
    lc_kwargs: {
      content: [{ text: "Path: /kb/invoice.md\nInvoice total is 50." }],
    },
    self: "[Circular]",
  });

  assert.deepEqual(output, {
    content: "Path: /kb/invoice.md\nInvoice total is 50.",
  });
});

test("preserves non-read_file tool outputs", () => {
  const output = { content: "search result", self: "[Circular]" };

  assert.equal(
    normalizeToolOutputForObservability("search_sources", output),
    output,
  );
});

test("parses DeepAgents write_todos input into display-safe todos", () => {
  assert.deepEqual(
    testExports.parseDeepAgentTodos({
      todos: [
        { content: "Inspect current runner", status: "completed" },
        { content: "Surface todos in trace", status: "in_progress" },
        { content: "Run tests", status: "pending" },
        { content: "Skip invalid status", status: "blocked" },
        { content: "   ", status: "pending" },
      ],
    }),
    [
      { content: "Inspect current runner", status: "completed" },
      { content: "Surface todos in trace", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ],
  );
});

test("builds a stable DeepAgents todo thinking step", () => {
  const todos = [
    { content: "Inspect current runner", status: "completed" as const },
    { content: "Surface todos in trace", status: "in_progress" as const },
    { content: "Run tests", status: "pending" as const },
  ];

  assert.deepEqual(
    testExports.buildDeepAgentTodosStep({
      toolCallId: "call-todos",
      todos,
    }),
    {
      id: "deepagents:todos",
      kind: "state",
      title: "Task plan",
      status: "in_progress",
      items: [
        "Completed: Inspect current runner",
        "In progress: Surface todos in trace",
        "Pending: Run tests",
      ],
      metadata: {
        source: "deepagents",
        tool: "write_todos",
        toolCallId: "call-todos",
        todos,
      },
    },
  );
});

test("derives DeepAgents todo step status from todo states", () => {
  assert.equal(
    testExports.resolveDeepAgentTodosStepStatus([
      { content: "Plan", status: "pending" },
    ]),
    "pending",
  );
  assert.equal(
    testExports.resolveDeepAgentTodosStepStatus([
      { content: "Plan", status: "completed" },
      { content: "Implement", status: "completed" },
    ]),
    "completed",
  );
  assert.equal(
    testExports.resolveDeepAgentTodosStepStatus([
      { content: "Plan", status: "completed" },
      { content: "Implement", status: "in_progress" },
    ]),
    "in_progress",
  );
});

test("sanitizes image blocks from persisted agent history", () => {
  const textOnly = new HumanMessage("hello");
  const imageMessage = new HumanMessage({
    content: [
      { type: "text", text: "what is this?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abcd" },
      },
    ],
  });
  const assistant = new AIMessage("answer");

  const result = agentTestExports.sanitizeMessagesForHistory([
    textOnly,
    imageMessage,
    assistant,
  ]);

  assert.equal(result.changed, true);
  assert.equal(result.messages[0], textOnly);
  assert.equal(result.messages[2], assistant);
  assert.deepEqual((result.messages[1] as HumanMessage).content, [
    { type: "text", text: "what is this?" },
    {
      type: "text",
      text: "[attached image 1: image, omitted from conversation history]",
    },
  ]);
});

test("command tool choice middleware allows initial support tool call", async () => {
  const middleware = agentTestExports.createCommandToolChoiceMiddleware({
    targetToolName: "generate_pptx",
  });
  const calls: Array<{ toolChoice?: unknown; tools: string[] }> = [];
  const request = {
    messages: [new HumanMessage("make deck")],
    state: { messages: [new HumanMessage("make deck")] },
    tools: [{ name: "web_search" }, { name: "generate_pptx" }],
  } as never;

  const response = await middleware.wrapModelCall?.(request, async (next) => {
    calls.push({
      toolChoice: next.toolChoice,
      tools: toolNames(next.tools),
    });
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          args: { query: "ASR history" },
          id: "call-search",
          name: "web_search",
        },
      ],
    });
  });

  assert.equal(AIMessage.isInstance(response), true);
  assert.deepEqual(calls, [
    {
      toolChoice: "auto",
      tools: ["web_search", "generate_pptx"],
    },
  ]);
});

test("command tool choice middleware forces target on first call for explicit tool command", async () => {
  const middleware = agentTestExports.createCommandToolChoiceMiddleware({
    targetToolName: "generate_pptx",
    mode: "force_target",
  });
  const calls: Array<{ toolChoice?: unknown; tools: string[] }> = [];
  const request = {
    messages: [new HumanMessage("make deck")],
    state: { messages: [new HumanMessage("make deck")] },
    tools: [{ name: "web_search" }, { name: "generate_pptx" }],
  } as never;

  const response = await middleware.wrapModelCall?.(request, async (next) => {
    calls.push({
      toolChoice: next.toolChoice,
      tools: toolNames(next.tools),
    });
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          args: { title: "ASR" },
          id: "call-pptx",
          name: "generate_pptx",
        },
      ],
    });
  });

  assert.equal(AIMessage.isInstance(response), true);
  assert.deepEqual(calls, [
    {
      toolChoice: agentTestExports.forcedToolChoice("generate_pptx"),
      tools: ["generate_pptx"],
    },
  ]);
});

test("command execution policy is disabled for incomplete clarification workflows", () => {
  const prepared = {
    command: {
      kind: "tool",
      workflow: {
        execution: "agent",
      },
    },
    commandSuccessCriteria: { kind: "none" },
  } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

  assert.equal(commandExecutionPolicyFor(prepared), undefined);
});

test("command execution policy force-targets complete explicit tool commands", () => {
  const prepared = {
    command: {
      kind: "tool",
      workflow: {
        execution: "agent",
      },
    },
    commandSuccessCriteria: {
      kind: "tool_call",
      toolName: "search_notion_pages",
    },
  } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

  assert.deepEqual(commandExecutionPolicyFor(prepared), {
    targetToolName: "search_notion_pages",
    mode: "force_target",
  });
});

test("command tool choice middleware fails fast when target tool is missing", async () => {
  const middleware = agentTestExports.createCommandToolChoiceMiddleware({
    targetToolName: "generate_pptx",
    mode: "force_target",
  });
  const request = {
    messages: [new HumanMessage("make deck")],
    state: { messages: [new HumanMessage("make deck")] },
    tools: [{ name: "web_search" }],
  } as never;

  await assert.rejects(
    async () => {
      await middleware.wrapModelCall?.(request, async () => new AIMessage("nope"));
    },
    /Command target tool 'generate_pptx' is not bound to the model request/,
  );
});

test("command tool choice middleware forces target after support tool call", async () => {
  const middleware = agentTestExports.createCommandToolChoiceMiddleware({
    targetToolName: "generate_pptx",
  });
  const calls: Array<{ toolChoice?: unknown; tools: string[] }> = [];
  const request = {
    messages: [],
    state: {
      messages: [
        new HumanMessage("make deck"),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              args: { query: "ASR history" },
              id: "call-search",
              name: "web_search",
            },
          ],
        }),
      ],
    },
    tools: [{ name: "web_search" }, { name: "generate_pptx" }],
  } as never;

  await middleware.wrapModelCall?.(request, async (next) => {
    calls.push({
      toolChoice: next.toolChoice,
      tools: toolNames(next.tools),
    });
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          args: { title: "ASR" },
          id: "call-pptx",
          name: "generate_pptx",
        },
      ],
    });
  });

  assert.deepEqual(calls, [
    {
      toolChoice: agentTestExports.forcedToolChoice("generate_pptx"),
      tools: ["generate_pptx"],
    },
  ]);
});

test("command tool choice middleware re-calls model when command drifts to text", async () => {
  const middleware = agentTestExports.createCommandToolChoiceMiddleware({
    targetToolName: "search_notion_pages",
  });
  const calls: Array<{ toolChoice?: unknown; tools: string[] }> = [];
  const request = {
    messages: [new HumanMessage("find page")],
    state: { messages: [new HumanMessage("find page")] },
    tools: [{ name: "web_search" }, { name: "search_notion_pages" }],
  } as never;

  const response = await middleware.wrapModelCall?.(request, async (next) => {
    calls.push({
      toolChoice: next.toolChoice,
      tools: toolNames(next.tools),
    });
    return calls.length === 1
      ? new AIMessage("I can search for that.")
      : new AIMessage({
          content: "",
          tool_calls: [
            {
              args: { query: "project" },
              id: "call-notion",
              name: "search_notion_pages",
            },
          ],
        });
  });

  assert.equal(AIMessage.isInstance(response), true);
  assert.deepEqual(calls, [
    {
      toolChoice: "auto",
      tools: ["web_search", "search_notion_pages"],
    },
    {
      toolChoice: agentTestExports.forcedToolChoice("search_notion_pages"),
      tools: ["search_notion_pages"],
    },
  ]);
});

test("normalizes web tool outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "Use these web search results internally.\n\n<web_result id='c1' rank='1' url='https://example.com/a' title='A'>Snippet</web_result>",
  );

  assert.deepEqual(output, {
    resultCount: 1,
    urlCount: 1,
    urls: ["https://example.com/a"],
    pages: [
      {
        url: "https://example.com/a",
        title: "A",
        rank: 1,
        citation: "c1",
        hasContent: false,
      },
    ],
    truncated: false,
  });
  assert.equal(
    JSON.stringify(output).includes("Use these web search results internally"),
    false,
  );
});

test("normalizes web_search failure outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_search",
    "web_search failed.\n\n<web_tool_error tool='web_search' provider='anycrawl' query='Shanghai weather' error='API Error 500: Internal server error'></web_tool_error>",
  );

  assert.deepEqual(output, {
    errorCount: 1,
    error: "API Error 500: Internal server error",
    query: "Shanghai weather",
    urlCount: 0,
    urls: [],
    truncated: false,
  });
});

test("connector tool error outputs are preserved for tool error handling", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    type: "connector_tool_error",
    code: "NOTION_TARGET_NOT_FOUND",
    message: "The provided sourceId does not resolve to an indexed Notion page.",
    statusCode: 400,
  });

  assert.deepEqual(output, {
    type: "connector_tool_error",
    code: "NOTION_TARGET_NOT_FOUND",
    message: "The provided sourceId does not resolve to an indexed Notion page.",
    statusCode: 400,
  });
});

test("model reasoning segment ids include the run trace id", () => {
  assert.equal(
    testExports.createModelReasoningSegmentId({
      runTraceId: "trace-1",
      index: 2,
    }),
    "model-reasoning:trace-1:2",
  );
});

test("messages stream handler yields reasoning before text deltas and records tool calls", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-messages" } as never,
  });

  const events = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        contentBlocks: [
          { type: "reasoning", text: "thinking through sources" },
          { type: "text", text: "Here is the answer." },
        ],
        response_metadata: {
          finish_reason: "stop",
          model_name: "test-model",
        },
        tool_calls: [
          {
            id: "call-search",
            name: "search_sources",
            args: { query: "alpha" },
          },
        ],
      },
    ],
    commandSuccessCriteria: { kind: "none" },
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["reasoning", "text-delta"],
  );
  assert.equal(events[0]?.type, "reasoning");
  assert.equal(
    events[0]?.type === "reasoning" ? events[0].reasoning : null,
    "thinking through sources",
  );
  assert.equal(events[1]?.type, "text-delta");
  assert.equal(
    events[1]?.type === "text-delta" ? events[1].delta : null,
    "Here is the answer.",
  );
  assert.equal(runtime.assistantContent, "Here is the answer.");
  assert.equal(runtime.modelReasoning, "thinking through sources");
  assert.equal(runtime.finishReason, "stop");
  assert.equal(runtime.providerFields?.model_name, "test-model");
  assert.deepEqual(runtime.observedToolCallsById.get("call-search"), {
    id: "call-search",
    name: "search_sources",
    args: { query: "alpha" },
    index: 0,
  });
});

test("HITL stream handler records update tool calls and assistant content without interrupting", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-updates" } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [
          {
            role: "assistant",
            content: "Draft answer from updates.",
            tool_calls: [
              {
                id: "call-search-updates",
                name: "search_sources",
                args: { query: "updates" },
              },
            ],
          },
        ],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.deepEqual(result, { kind: "continue" });
  assert.equal(runtime.assistantContentFromUpdates, "Draft answer from updates.");
  assert.deepEqual(runtime.observedToolCallsById.get("call-search-updates"), {
    id: "call-search-updates",
    name: "search_sources",
    args: { query: "updates" },
    index: 0,
  });
});

test("HITL stream handler records LangChain AIMessage update content", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-langchain-ai-message" } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [new AIMessage("LangChain answer from updates.")],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.deepEqual(result, { kind: "continue" });
  assert.equal(
    runtime.assistantContentFromUpdates,
    "LangChain answer from updates.",
  );
});

test("stream handlers ignore non-assistant messages", async () => {
  const updatesRuntime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-non-assistant" } as never,
  });
  const updatesResult = await collectHitlStreamResult({
    agent: { getState: vi.fn(), stream: vi.fn() } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      agent: {
        messages: [new HumanMessage("User text from updates.")],
      },
    },
    runConfig: {} as never,
    runtime: updatesRuntime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(updatesResult.events, []);
  assert.deepEqual(updatesResult.result, { kind: "continue" });
  assert.equal(updatesRuntime.assistantContentFromUpdates, null);

  const messagesRuntime = createTurnRuntime({
    prepared: { runTraceId: "trace-message-non-assistant" } as never,
  });
  const messageEvents = await collectMessageStreamEvents({
    payload: [new HumanMessage("User text from messages stream.")],
    commandSuccessCriteria: { kind: "none" },
    runtime: messagesRuntime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(messageEvents, []);
  assert.equal(messagesRuntime.assistantContent, "");
  assert.equal(messagesRuntime.hasStreamedText, false);
});

test("HITL stream handler emits confirmation event sequence and interrupted final outcome", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-confirmation" } as never,
  });
  runtime.assistantContent = "I need approval";
  runtime.hasTextSinceLastToolBoundary = true;
  runtime.renderBlocks.appendText("I need approval");
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-1",
    domain: "mcp",
    subject: { label: "GitHub", provider: "mcp" },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create issue",
      summary: "Create issue",
      requestJson: { title: "Ship task 5" },
    },
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "mcp_action_run", actionRunId: "approval-1" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  } as never;
  const approvalMock = vi
    .spyOn(mcpService, "createApprovalForInterruptedTool")
    .mockResolvedValue(confirmation);

  try {
    const { events, result } = await collectHitlStreamResult({
      agent: {
        getState: vi.fn().mockResolvedValue({
          config: {
            configurable: {
              thread_id: "agent-thread-1",
              checkpoint_id: "pending-checkpoint",
              checkpoint_ns: "",
            },
          },
          next: ["tools"],
        }),
        stream: vi.fn(),
      } as never,
      autoApprovedHitlResumeCount: 0,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: {
        threadId: "agent-thread-1",
        checkpointId: "before-input",
      },
      connectorToolContext: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      finalCheckpoint: {
        threadId: "agent-thread-1",
        checkpointId: "observed-checkpoint",
      },
      maxAutoApprovedHitlResumes: 1,
      payload: {
        __interrupt__: [
          {
            id: "interrupt-1",
            value: {
              actionRequests: [
                {
                  name: "mcp__github__create_issue",
                  args: { title: "Ship task 5" },
                },
              ],
              reviewConfigs: [
                {
                  actionName: "mcp__github__create_issue",
                  allowedDecisions: ["approve", "edit", "reject"],
                  argsSchema: { type: "object" },
                },
              ],
            },
          },
        ],
        agent: {
          messages: [
            {
              role: "assistant",
              content: "Need approval",
              tool_calls: [
                {
                  id: "call-approval",
                  name: "mcp__github__create_issue",
                  args: { title: "Ship task 5" },
                },
              ],
            },
          ],
        },
      },
      runConfig: {} as never,
      runtime,
      threadId: "thread-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "text-interrupted",
        "text-delta",
        "tool-call-start",
        "tool-call-result",
        "tool-call-end",
        "done",
      ],
    );
    assert.deepEqual(result, { kind: "done" });
    assert.equal(events[2]?.type, "tool-call-start");
    assert.equal(
      events[2]?.type === "tool-call-start" ? events[2].toolCall.status : null,
      "running",
    );
    assert.equal(events[3]?.type, "tool-call-result");
    assert.deepEqual(
      events[3]?.type === "tool-call-result"
        ? (events[3].output as { execution?: { sourceweft?: unknown } }).execution
            ?.sourceweft
        : null,
      { hitlInterruptId: "interrupt-1" },
    );
    assert.equal(events[5]?.type, "done");
    const outcome = events[5]?.type === "done" ? events[5].outcome : null;
    assert.equal(outcome?.finishReason, "tool_confirmation_requested");
    assert.equal(outcome?.assistantContent, "I need approval");
    assert.deepEqual(outcome?.agentCheckpoint, {
      beforeInput: {
        threadId: "agent-thread-1",
        checkpointId: "before-input",
      },
      beforeAssistant: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
      resume: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
      final: {
        threadId: "agent-thread-1",
        checkpointId: "pending-checkpoint",
        checkpointNs: "",
      },
    });
    assert.equal(approvalMock.mock.calls[0]?.[0].toolCallId, "call-approval");
  } finally {
    approvalMock.mockRestore();
  }
});

test("HITL stream handler matches tool calls from pending checkpoint state", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-state-tool-call" } as never,
  });
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "approval-state-1",
    domain: "mcp",
    subject: { label: "GitHub", provider: "mcp" },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      riskLevel: "medium",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Create issue",
      summary: "Create issue",
      requestJson: { title: "Ship state task" },
    },
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "mcp_action_run", actionRunId: "approval-state-1" },
    },
    status: "proposed",
    userMessage: "Waiting for confirmation.",
  } as never;
  const approvalMock = vi
    .spyOn(mcpService, "createApprovalForInterruptedTool")
    .mockResolvedValue(confirmation);

  try {
    const { events, result } = await collectHitlStreamResult({
      agent: {
        getState: vi.fn().mockResolvedValue({
          config: {
            configurable: {
              thread_id: "agent-thread-1",
              checkpoint_id: "pending-checkpoint",
              checkpoint_ns: "",
            },
          },
          next: ["tools"],
          values: {
            messages: [
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-from-state",
                    name: "mcp__github__create_issue",
                    args: { title: "Ship state task" },
                  },
                ],
              },
            ],
          },
        }),
        stream: vi.fn(),
      } as never,
      autoApprovedHitlResumeCount: 0,
      beforeAssistantCheckpoint: null,
      beforeInputCheckpoint: null,
      connectorToolContext: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      finalCheckpoint: null,
      maxAutoApprovedHitlResumes: 1,
      payload: {
        __interrupt__: [
          {
            id: "interrupt-from-state",
            value: {
              actionRequests: [
                {
                  name: "mcp__github__create_issue",
                  args: { title: "Ship state task" },
                },
              ],
              reviewConfigs: [
                {
                  actionName: "mcp__github__create_issue",
                  allowedDecisions: ["approve", "edit", "reject"],
                },
              ],
            },
          },
        ],
      },
      runConfig: {} as never,
      runtime,
      threadId: "thread-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    assert.deepEqual(
      events.map((event) => event.type),
      ["tool-call-start", "tool-call-result", "tool-call-end", "done"],
    );
    assert.deepEqual(result, { kind: "done" });
    assert.equal(approvalMock.mock.calls[0]?.[0].toolCallId, "call-from-state");
    assert.equal(events[0]?.type, "tool-call-start");
    assert.equal(
      events[0]?.type === "tool-call-start" ? events[0].id : null,
      "call-from-state",
    );
  } finally {
    approvalMock.mockRestore();
  }
});

test("HITL stream handler creates sandbox confirmation without connector or Daytona backend", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-sandbox-confirmation" } as never,
  });

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue({
        config: {
          configurable: {
            thread_id: "agent-thread-sandbox",
            checkpoint_id: "pending-sandbox-checkpoint",
            checkpoint_ns: "",
          },
        },
        next: ["tools"],
      }),
      stream: vi.fn(),
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    finalCheckpoint: null,
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "sandbox-interrupt-1",
          value: {
            actionRequests: [
              {
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test", workingDir: "/workspace/work" },
                description: "Run tests in the sandbox runtime.",
              },
            ],
            reviewConfigs: [
              {
                actionName: AGENT_TOOL_NAMES.execute,
                allowedDecisions: ["approve", "edit", "reject"],
                argsSchema: { type: "object" },
              },
            ],
          },
        },
      ],
      agent: {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-sandbox-execute",
                name: AGENT_TOOL_NAMES.execute,
                args: { command: "npm test", workingDir: "/workspace/work" },
              },
            ],
          },
        ],
      },
    },
    runConfig: {} as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-start", "tool-call-result", "tool-call-end", "done"],
  );
  assert.deepEqual(result, { kind: "done" });
  assert.equal(events[1]?.type, "tool-call-result");
  const output =
    events[1]?.type === "tool-call-result"
      ? (events[1].output as Record<string, unknown>)
      : null;
  assert.equal(output?.type, "tool_confirmation_request");
  assert.equal(output?.domain, "sandbox");
  assert.deepEqual(
    (output?.execution as { sourceweft?: unknown } | undefined)?.sourceweft,
    {
      hitlInterruptId: "sandbox-interrupt-1",
      sandboxExecuteToolCallId: "call-sandbox-execute",
    },
  );
  assert.deepEqual(
    (output?.editableArgs as { value?: unknown } | undefined)?.value,
    { command: "npm test", workingDir: "/workspace/work" },
  );
  assert.equal(events[3]?.type, "done");
  const outcome = events[3]?.type === "done" ? events[3].outcome : null;
  assert.equal(outcome?.finishReason, "tool_confirmation_requested");
  assert.equal(outcome?.toolCalls[0]?.tool, AGENT_TOOL_NAMES.execute);
  assert.equal(outcome?.toolCalls[0]?.status, "approval_requested");
});

test("HITL stream handler returns replace-stream for auto-approved connector resume", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-auto-resume" } as never,
  });
  const replacementStream = emptyAgentStream();
  let resumeCommand: unknown;
  const streamMock = vi.fn().mockImplementation((command: unknown) => {
    resumeCommand = command;
    return replacementStream;
  });
  const connectorToolContext = {
    actionExecutionCursor: {
      refs: [
        {
          actionRunId: "action-1",
          connectorId: "connector-1",
          requestJson: { pageId: "page-1" },
          toolName: "delete_notion_page",
        },
      ],
      value: 0,
    },
    actionApprovalScope: undefined as string | undefined,
    teamId: "team-1",
    workspaceId: "workspace-1",
    userId: "user-1",
  };

  const { events, result } = await collectHitlStreamResult({
    agent: {
      getState: vi.fn().mockResolvedValue(null),
      stream: streamMock,
    } as never,
    autoApprovedHitlResumeCount: 0,
    beforeAssistantCheckpoint: null,
    beforeInputCheckpoint: null,
    connectorToolContext,
    finalCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "observed-checkpoint",
    },
    maxAutoApprovedHitlResumes: 1,
    payload: {
      __interrupt__: [
        {
          id: "interrupt-1",
          value: {
            actionRequests: [
              {
                name: "delete_notion_page",
                args: { connectorId: "connector-1", pageId: "page-1" },
              },
            ],
            reviewConfigs: [
              {
                actionName: "delete_notion_page",
                allowedDecisions: ["approve", "reject"],
              },
            ],
          },
        },
      ],
    },
    runConfig: { configurable: { thread_id: "agent-thread-1" } } as never,
    runtime,
    threadId: "thread-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(events, []);
  assert.equal(result.kind, "replace-stream");
  assert.equal(result.kind === "replace-stream" ? result.stream : null, replacementStream);
  assert.equal(
    result.kind === "replace-stream" ? result.autoApprovedHitlResumeCount : null,
    1,
  );
  assert.deepEqual(
    result.kind === "replace-stream" ? result.finalCheckpoint : null,
    { threadId: "agent-thread-1", checkpointId: "observed-checkpoint" },
  );
  assert.equal(connectorToolContext.actionApprovalScope, "agent-thread-1:observed-checkpoint");
  assert.equal(streamMock.mock.calls.length, 1);
  assert.deepEqual(
    (resumeCommand as { lg_name?: string; resume?: unknown }).resume,
    {
      "interrupt-1": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("HITL stream handler preserves missing checkpoint content error", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-hitl-missing-checkpoint" } as never,
  });

  await assert.rejects(
    async () => {
      await collectHitlStreamResult({
        agent: {
          getState: vi.fn().mockResolvedValue(null),
          stream: vi.fn(),
        } as never,
        autoApprovedHitlResumeCount: 0,
        beforeAssistantCheckpoint: null,
        beforeInputCheckpoint: null,
        connectorToolContext: {
          teamId: "team-1",
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        finalCheckpoint: null,
        maxAutoApprovedHitlResumes: 1,
        payload: {
          __interrupt__: [
            {
              value: {
                actionRequests: [
                  {
                    name: "delete_notion_page",
                    args: { pageId: "page-1" },
                  },
                ],
                reviewConfigs: [
                  {
                    actionName: "delete_notion_page",
                    allowedDecisions: ["approve", "reject"],
                  },
                ],
              },
            },
          ],
        },
        runConfig: {} as never,
        runtime,
        threadId: "thread-1",
        userId: "user-1",
        workspaceId: "workspace-1",
      });
    },
    (error: unknown) => {
      assert.equal(error instanceof ContentError, true);
      assert.equal((error as ContentError).statusCode, 409);
      assert.equal((error as ContentError).code, "AGENT_HITL_CHECKPOINT_MISSING");
      assert.equal(
        (error as ContentError).message,
        "DeepAgents HITL interrupt did not provide a resumable checkpoint.",
      );
      return true;
    },
  );
});

test("connector success outputs hide raw provider payloads", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    url: "https://www.notion.so/page",
    title: "服务器配置查询总结",
    pageId: "page-1",
    postActionSyncRunId: "sync-1",
    content: "private conversation summary",
  });

  assert.deepEqual(output, {
    type: "connector_tool_result",
    connector: "notion",
    toolName: "create_notion_page",
    title: "服务器配置查询总结",
    url: "https://www.notion.so/page",
    pageId: "page-1",
  });
});

test("connector search outputs preserve public result details", () => {
  const output = normalizeToolOutputForObservability("search_notion_pages", {
    actionType: "notion.page.find",
    query: "服务器",
    resultCount: 2,
    pages: [
      {
        pageId: "page-1",
        title: "服务器配置",
        url: "https://www.notion.so/page-1",
        lastEditedTime: "2026-05-23T01:00:00.000Z",
        content: "private page body",
      },
      {
        pageId: "page-2",
        title: "服务器部署",
        url: "https://www.notion.so/page-2",
      },
    ],
  });

  assert.deepEqual(output, {
    type: "connector_tool_result",
    connector: "notion",
    toolName: "search_notion_pages",
    actionType: "notion.page.find",
    query: "服务器",
    resultCount: 2,
    pages: [
      {
        pageId: "page-1",
        title: "服务器配置",
        url: "https://www.notion.so/page-1",
        lastEditedTime: "2026-05-23T01:00:00.000Z",
      },
      {
        pageId: "page-2",
        title: "服务器部署",
        url: "https://www.notion.so/page-2",
      },
    ],
  });
});

test("connector confirmation outputs hide editable request payloads", () => {
  const output = normalizeToolOutputForObservability("create_notion_page", {
    type: "tool",
    lc_kwargs: {
      content: JSON.stringify({
        type: "tool_confirmation_request",
        schemaVersion: 1,
        id: "action-1",
        domain: "connector",
        subject: {
          label: "Lei Qin",
          provider: "notion",
          connectorId: "connector-1",
        },
        action: {
          type: "notion.page.create",
          toolName: "create_notion_page",
          label: "Create",
          riskLevel: "medium",
          status: "proposed",
          requiresApproval: true,
        },
        preview: {
          title: "Create Notion page: 服务器配置查询总结",
          requestJson: {
            title: "服务器配置查询总结",
            content: "private conversation summary",
          },
        },
        editableArgs: {
          value: {
            title: "服务器配置查询总结",
            content: "private conversation summary",
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
        userMessage: "Waiting for confirmation.",
      }),
    },
  });

  assert.equal(
    (output as Record<string, unknown>).type,
    "tool_confirmation_request",
  );
  assert.equal(
    "requestJson" in
      ((output as Record<string, unknown>).preview as Record<string, unknown>),
    false,
  );
  assert.equal("editableArgs" in (output as Record<string, unknown>), false);
});

test("connector approval mismatches are surfaced as content errors", () => {
  const error = testExports.getConnectorToolOutputContentError({
    type: "connector_tool_error",
    code: "CONNECTOR_ACTION_NOT_APPROVED",
    message:
      "Approved action was not found for this resumed tool call. Please retry the confirmation.",
    statusCode: 409,
  });

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
  assert.equal(error?.statusCode, 409);
});

test("connector approval mismatches are detected inside ToolMessage content", () => {
  const error = testExports.getConnectorToolOutputContentError({
    type: "tool",
    lc_kwargs: {
      content: JSON.stringify({
        type: "connector_tool_error",
        code: "CONNECTOR_ACTION_NOT_APPROVED",
        message:
          "Approved action was not found for this resumed tool call. Please retry the confirmation.",
        statusCode: 409,
      }),
    },
  });

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
});

test("connector approval mismatches are detected inside tool error text", () => {
  const error = testExports.getConnectorToolErrorTextContentError(
    "Error: Connector action must be approved before execution\n Please fix your mistakes.",
  );

  assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
});

test("DeepAgents resume input excludes SourceWeft connector execution metadata", () => {
  assert.deepEqual(
    testExports.commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        connectorActions: [
          {
            actionRunId: "action_1",
            connectorId: "connector_1",
            toolName: "create_notion_page",
          },
        ],
      },
    }),
    {
      decisions: [{ type: "approve" }],
    },
  );
});

test("DeepAgents HITL duplicate connector interrupts auto-resume from approved execution refs", () => {
  const actionExecutionCursor: ConnectorActionExecutionCursor = {
    refs: [
      {
        actionRunId: "delete-action",
        connectorId: "connector-1",
        requestJson: { pageId: "placeholder-page" },
        toolName: "delete_notion_page",
      },
    ],
    value: 0,
  };
  const context = {
    actionExecutionCursor,
  };

  assert.deepEqual(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: context,
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "placeholder-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
  assert.equal(context.actionExecutionCursor.value, 0);
  assert.equal(context.actionExecutionCursor.consumedActionRunIds, undefined);
});

test("DeepAgents HITL auto-resume matches approved refs when replay adds undefined optional args", () => {
  assert.deepEqual(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "create-action",
              connectorId: "connector-1",
              requestJson: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
              },
              toolName: "create_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: {
                title: "测试",
                content: "这是一个占位页面。",
                parentPageId: "367dadfc-4a0b-8026-996a-f6fd70dc6043",
                dataSourceId: undefined,
                pageId: undefined,
              },
              name: "create_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "create_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    [{ type: "approve" }],
  );
});

test("trace continuation keeps approval tool sequence and advances new events", () => {
  const allocator = testExports.createTraceSequenceAllocator({
    traceContinuation: {
      maxSequence: 4,
      toolSequenceById: {
        "approval-tool": 4,
      },
    },
  });

  assert.equal(allocator.resolveToolCallSequence("approval-tool"), 4);
  assert.equal(allocator.nextSequence(), 5);
  assert.equal(allocator.resolveToolCallSequence("new-tool"), 6);
  assert.equal(allocator.resolveToolCallSequence("new-tool"), 6);
  assert.equal(allocator.nextSequence(), 7);
});

test("DeepAgents HITL resume targets the persisted interrupt id when present", () => {
  assert.deepEqual(
    testExports.commandResumeFromToolApprovalResume({
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "0123456789abcdef0123456789abcdef",
      },
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents sandbox HITL edit resume targets the persisted interrupt id", () => {
  assert.deepEqual(
    testExports.commandResumeFromToolApprovalResume({
      decisions: [
        {
          type: "edit",
          editedAction: {
            name: AGENT_TOOL_NAMES.execute,
            args: { command: "pnpm test" },
          },
        },
      ],
      sourceweft: {
        hitlInterruptId: "sandbox-interrupt-1",
      },
    }),
    {
      "sandbox-interrupt-1": {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: AGENT_TOOL_NAMES.execute,
              args: { command: "pnpm test" },
            },
          },
        ],
      },
    },
  );
});

test("DeepAgents auto-approved HITL resume targets the interrupt id when present", () => {
  assert.deepEqual(
    testExports.commandResumeFromHitlDecisions({
      decisions: [{ type: "approve" }],
      hitlInterruptId: "0123456789abcdef0123456789abcdef",
    }),
    {
      "0123456789abcdef0123456789abcdef": {
        decisions: [{ type: "approve" }],
      },
    },
  );
});

test("DeepAgents HITL auto-resume does not approve unmatched connector args", () => {
  assert.equal(
    testExports.buildAutoApprovedHitlResumeDecisions({
      connectorContext: {
        actionExecutionCursor: {
          refs: [
            {
              actionRunId: "delete-action",
              connectorId: "connector-1",
              requestJson: { pageId: "approved-page" },
              toolName: "delete_notion_page",
            },
          ],
          value: 0,
        },
      },
      hitlInterrupts: [
        {
          actionRequests: [
            {
              args: { pageId: "different-page" },
              name: "delete_notion_page",
            },
          ],
          reviewConfigs: [
            {
              actionName: "delete_notion_page",
              allowedDecisions: ["approve", "reject"],
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("final assistant text stays empty for tool-only successful turns", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: true,
    }),
    "",
  );
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
    }),
    "Model returned an empty response.",
  );
});

test("final assistant text preserves natural artifact summaries", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "已生成 PPT，重点是概念、步骤和练习。",
      assistantContentFromUpdates: null,
      commandSuccessCriteria: {
        artifactType: "slides",
        kind: "artifact",
        toolName: "generate_pptx",
      },
      hasCompletedToolOutput: true,
    }),
    "已生成 PPT，重点是概念、步骤和练习。",
  );
});

test("final assistant text can stay silent for rejected approval resumes", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "",
  );
});

test("final assistant text suppresses leaked video scene specs", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: JSON.stringify({
        schemaVersion: 1,
        title: "费曼学习法",
        fps: 30,
        width: 1920,
        height: 1080,
        theme: { background: "#fff" },
        narrationEnabled: true,
        slides: [{ title: "Intro" }],
        scenes: [{ slideNumber: 1 }],
      }),
      assistantContentFromUpdates: null,
      commandSuccessCriteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      hasCompletedToolOutput: false,
    }),
    "",
  );
});

test("suppresses streamed leaked video scene specs for video command", () => {
  const criteria = {
    artifactType: "video_presentation" as const,
    kind: "artifact" as const,
    toolName: "generate_video_presentation",
  };

  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: "",
      criteria,
      delta: '{"schemaVersion":1,',
      suppressing: false,
    }),
    false,
  );
  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: '{"schemaVersion":1,',
      criteria,
      delta:
        '"title":"费曼学习法","slides":[],"scenes":[],"narrationEnabled":true}',
      suppressing: false,
    }),
    true,
  );
  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: "",
      criteria,
      delta: "正常说明",
      suppressing: false,
    }),
    false,
  );
});

test("suppresses leaked presentation specs without suppressing natural summaries", () => {
  const criteria = {
    artifactType: "slides" as const,
    kind: "artifact" as const,
    toolName: "generate_pptx",
  };

  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: "",
      criteria,
      delta:
        '{"title":"费曼学习法","generationMode":"visual_html","slides":[{"kind":"title","claim":"费曼学习法"}]}',
      suppressing: false,
    }),
    true,
  );
  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: "",
      criteria,
      delta:
        "我已经生成了这份费曼学习法的 PPT，结构是概念、步骤和练习。",
      suppressing: false,
    }),
    false,
  );
  assert.equal(
    testExports.shouldSuppressLeakedCommandSpecText({
      assistantContent: "",
      criteria,
      delta: "artifact_url: /artifact-preview?artifactId=artifact-1",
      suppressing: false,
    }),
    true,
  );
});

test("presentation generation trace step stays active before tool execution", () => {
  const step = testExports.buildPresentationGenerationStep({
    phase: "planning",
  });

  assert.equal(step.id, "presentation-generation");
  assert.equal(step.title, "Generating presentation");
  assert.equal(step.status, "in_progress");
  assert.equal(step.metadata?.phase, "planning");
});

test("presentation generation trace step records completed artifacts", () => {
  const step = testExports.buildPresentationGenerationStep({
    latencyMs: 1234,
    phase: "completed",
    toolCallId: "call-1",
  });

  assert.equal(step.title, "Generated presentation");
  assert.equal(step.status, "completed");
  assert.deepEqual(step.items, ["Presentation artifact created"]);
  assert.equal(step.metadata?.toolCallId, "call-1");
  assert.equal(step.metadata?.latencyMs, 1234);
});

test("presentation generation trace step records needs_content repair state", () => {
  const step = testExports.buildPresentationGenerationStep({
    phase: "repairing",
    toolCallId: "call-1",
  });

  assert.equal(step.title, "Generating presentation");
  assert.equal(step.status, "in_progress");
  assert.deepEqual(step.items, ["Adding explicit slide content"]);
  assert.equal(
    step.description,
    "The deck tool needs a complete deck plan before artifact creation.",
  );
  assert.equal(step.metadata?.phase, "repairing");
});

test("presentation progress events map to CoT-safe generation steps", () => {
  const planning = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "generate_pptx_progress",
      toolCallId: "call-1",
      stage: "planning",
      title: "Launch deck",
    },
    toolCallId: "call-1",
  });
  const generating = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "generate_pptx_progress",
      toolCallId: "call-1",
      stage: "generating",
      slideCount: 8,
    },
    toolCallId: "call-1",
  });
  const saving = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "generate_pptx_progress",
      toolCallId: "call-1",
      stage: "saving",
      fileName: "launch-deck.html",
    },
    toolCallId: "call-1",
  });
  const ready = testExports.buildPresentationProgressThinkingStep({
    data: {
      type: "generate_pptx_progress",
      toolCallId: "call-1",
      stage: "ready",
      artifactId: "artifact-1",
    },
    toolCallId: "call-1",
  });

  assert.equal(planning?.id, "presentation-generation");
  assert.equal(planning?.title, "Generating presentation");
  assert.equal(planning?.status, "in_progress");
  assert.deepEqual(planning?.items, [
    "Planning deck content and visual structure",
  ]);
  assert.deepEqual(generating?.items, ["Rendering slides"]);
  assert.equal(generating?.status, "in_progress");
  assert.deepEqual(saving?.items, ["Saving presentation artifact"]);
  assert.equal(saving?.status, "in_progress");
  assert.equal(ready?.title, "Generated presentation");
  assert.equal(ready?.status, "completed");
  assert.deepEqual(ready?.items, ["Presentation artifact created"]);
  assert.equal(ready?.metadata?.toolCallId, "call-1");
});

test("unknown presentation progress stages do not create CoT steps", () => {
  assert.equal(
    testExports.buildPresentationProgressThinkingStep({
      data: {
        type: "generate_pptx_progress",
        toolCallId: "call-1",
        stage: "internal_layout_pass",
      },
      toolCallId: "call-1",
    }),
    null,
  );
});

test("presentation progress emits tool event before CoT step", () => {
  const sequence: number[] = [];
  const progressEvent = normalizeGeneratedPresentationProgressEvent({
    type: "generate_pptx_progress",
    toolCallId: "call-1",
    stage: "saving",
  });
  assert.ok(progressEvent);
  const thinkingEvent = testExports.buildPresentationProgressThinkingEvent({
    progressEvent,
    setThinkingStep: (step) => ({
      ...step,
      sequence: sequence.push(sequence.length + 1),
    }),
  });
  assert.ok(thinkingEvent);

  const events = [
    {
      type: "tool-call-event" as const,
      id: progressEvent.toolCallId,
      tool: progressEvent.tool,
      data: progressEvent.data,
      toolCall: {
        id: progressEvent.toolCallId,
        tool: progressEvent.tool,
        input: {},
        output: progressEvent.data,
        status: "running" as const,
        latencyMs: null,
        error: null,
      },
    },
    thinkingEvent,
  ];

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-call-event", "thinking-step"],
  );
  const stepEvent = events[1];
  assert.equal(stepEvent?.type, "thinking-step");
  assert.deepEqual(
    stepEvent?.type === "thinking-step" ? stepEvent.step.items : [],
    ["Saving presentation artifact"],
  );
});

test("custom stream handler emits generated artifact progress events", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-custom-progress" } as never,
  });
  runtime.toolCallsById.set("image-call", {
    id: "image-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });
  runtime.toolCallsById.set("pptx-call", {
    id: "pptx-call",
    tool: "generate_pptx",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 2,
  });
  runtime.toolCallsById.set("video-call", {
    id: "video-call",
    tool: "generate_video_presentation",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 3,
  });

  const imageEvents = await collectCustomStreamEvents({
    payload: {
      type: "generate_image_progress",
      toolCallId: "image-call",
      tool: "ignored_tool_name",
      stage: "generating",
    },
    runtime,
  });
  const pptxEvents = await collectCustomStreamEvents({
    payload: {
      type: "generate_pptx_progress",
      toolCallId: "pptx-call",
      stage: "saving",
    },
    runtime,
  });
  const videoEvents = await collectCustomStreamEvents({
    payload: {
      type: "generate_video_presentation_progress",
      toolCallId: "video-call",
      stage: "generating_audio",
    },
    runtime,
  });

  assert.deepEqual(
    imageEvents.map((event) => event.type),
    ["tool-call-event"],
  );
  assert.deepEqual(
    pptxEvents.map((event) => event.type),
    ["tool-call-event", "thinking-step"],
  );
  assert.deepEqual(
    videoEvents.map((event) => event.type),
    ["tool-call-event"],
  );
  assert.equal(imageEvents[0]?.type, "tool-call-event");
  assert.equal(
    imageEvents[0]?.type === "tool-call-event" ? imageEvents[0].tool : null,
    "generate_image",
  );
  assert.equal(pptxEvents[0]?.type, "tool-call-event");
  assert.equal(
    pptxEvents[0]?.type === "tool-call-event" ? pptxEvents[0].tool : null,
    "generate_pptx",
  );
  assert.equal(pptxEvents[1]?.type, "thinking-step");
  assert.deepEqual(
    pptxEvents[1]?.type === "thinking-step" ? pptxEvents[1].step.items : [],
    ["Saving presentation artifact"],
  );
  assert.equal(videoEvents[0]?.type, "tool-call-event");
  assert.equal(
    videoEvents[0]?.type === "tool-call-event" ? videoEvents[0].tool : null,
    "generate_video_presentation",
  );
  assert.equal(
    runtime.toolCallsById.get("pptx-call")?.output,
    pptxEvents[0]?.type === "tool-call-event" ? pptxEvents[0].data : null,
  );
});

test("custom stream handler ignores unknown custom payloads", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-unknown-custom-progress" } as never,
  });
  runtime.toolCallsById.set("known-call", {
    id: "known-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });

  const events = await collectCustomStreamEvents({
    payload: {
      type: "unrelated_custom_event",
      toolCallId: "known-call",
      stage: "generating",
    },
    runtime,
  });

  assert.deepEqual(events, []);
  assert.deepEqual(runtime.toolCallsById.get("known-call"), {
    id: "known-call",
    tool: "generate_image",
    input: {},
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: 1,
  });
});

test("final assistant text prefers real assistant content over silent approval resume", () => {
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "The action was cancelled.",
      assistantContentFromUpdates: null,
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "The action was cancelled.",
  );
  assert.equal(
    testExports.resolveFinalAssistantText({
      assistantContent: "",
      assistantContentFromUpdates: "The action was cancelled.",
      hasCompletedToolOutput: false,
      allowSilentEmptyResponse: true,
    }),
    "The action was cancelled.",
  );
});

test("rejected approval resume can silence empty continuations", () => {
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject", message: "User rejected the action." }],
      },
    }),
    true,
  );
});

test("approval resume silence requires reject decision and existing assistant message", () => {
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "approve" }],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: "delete_notion_page",
              args: { pageId: "page-1" },
            },
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: null,
      hasCompletedToolOutput: false,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
  assert.equal(
    testExports.shouldSilenceEmptyApprovalResume({
      assistantMessageId: "assistant-message-1",
      hasCompletedToolOutput: true,
      toolApprovalResume: {
        decisions: [{ type: "reject" }],
      },
    }),
    false,
  );
});

test("HITL replay maps to the interrupted checkpoint without top-level checkpoint_id", () => {
  const config = testExports.resolveAgentBaseConfig({
    agentMode: "replay",
    agentRunThreadId: "unused-resume-thread",
    agentBaseCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "interrupted-checkpoint",
      checkpointNs: "",
    },
  });

  assert.deepEqual(config, {
    configurable: {
      thread_id: "agent-thread-1",
      checkpoint_map: {
        "": "interrupted-checkpoint",
      },
      checkpoint_ns: "",
    },
  });
  assert.equal(
    "checkpoint_id" in config.configurable,
    false,
    "LangGraph keeps skipDoneTasks enabled only when checkpoint_id is not a top-level configurable key",
  );
});

test("HITL interrupt checkpoint prefers the current stream checkpoint when getState is stale", () => {
  const checkpoint = testExports.resolveHitlInterruptCheckpoint({
    pendingCheckpoint: {
      pending: false,
      checkpoint: {
        threadId: "agent-thread-1",
        checkpointId: "old-fork-base",
      },
    },
    observedCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "current-interrupt",
    },
  });

  assert.deepEqual(checkpoint, {
    threadId: "agent-thread-1",
    checkpointId: "current-interrupt",
  });
});

test("HITL interrupt checkpoint uses pending getState checkpoint when available", () => {
  const checkpoint = testExports.resolveHitlInterruptCheckpoint({
    pendingCheckpoint: {
      pending: true,
      checkpoint: {
        threadId: "agent-thread-1",
        checkpointId: "pending-interrupt",
      },
    },
    observedCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "current-interrupt",
    },
  });

  assert.deepEqual(checkpoint, {
    threadId: "agent-thread-1",
    checkpointId: "pending-interrupt",
  });
});

test("fork mode pins the requested checkpoint", () => {
  const config = testExports.resolveAgentBaseConfig({
    agentMode: "fork",
    agentRunThreadId: "unused-refresh-thread",
    agentBaseCheckpoint: {
      threadId: "agent-thread-1",
      checkpointId: "before-input",
    },
  });

  assert.deepEqual(config, {
    configurable: {
      thread_id: "agent-thread-1",
      checkpoint_id: "before-input",
      checkpoint_ns: "",
    },
  });
});

test("normalizes all-failed web_fetch outputs to display-safe metadata", () => {
  const output = normalizeToolOutputForObservability(
    "web_fetch",
    "<web_page rank='1' url='https://example.com' error='API Error 500: Internal server error'></web_page>",
  );

  assert.deepEqual(output, {
    pageCount: 1,
    errorCount: 1,
    urlCount: 1,
    urls: ["https://example.com"],
    pages: [
      {
        url: "https://example.com",
        rank: 1,
        error: "API Error 500: Internal server error",
        hasContent: true,
      },
    ],
    truncated: false,
  });
});

test("resolveDirectToolCommand uses clean message content when display content has markers", () => {
  const command = testExports.resolveDirectToolCommand({
    artifactIntent: {
      kind: "image",
      shouldInjectTool: true,
      source: "explicit_tool",
      confidence: 1,
      reason: "explicit tool",
      config: {
        aspectRatio: "auto",
        quality: "auto",
        style: "auto",
      },
      warnings: [],
    },
    command: {
      arguments: "",
      canonicalName: "/generate_image",
      description: "Generate image",
      displayName: "Generate image",
      kind: "tool",
      name: "/generate_image",
      skillSlug: "",
      toolName: "generate_image",
      workflow: {
        arguments: "",
        defaultTools: ["generate_image"],
        execution: "direct",
        kind: "tool_workflow",
        name: "/generate_image",
        permissionOverrides: {
          generate_image: "allow",
        },
        renderedPrompt: "",
        successCriteria: {
          artifactType: "image",
          kind: "artifact",
          toolName: "generate_image",
        },
      },
    },
    generateImageTool: {
      enabled: true,
      mode: "generate",
    },
    imageProfile: {
      capabilities: {
        controls: {},
        supported: true,
      },
      profile: {
        id: "profile-1",
        kind: "image",
        gatewayConfigId: "gateway-1",
        profileAlias: "image-default",
        modelAlias: "image-model",
        requestedDimensions: null,
        vectorStrategy: "disabled",
        isDefault: true,
        isActive: true,
        configJson: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    },
    messageContent: "draw a dashboard",
    userMessage: {
      content: "[tool:generate_image](Generate image) draw a dashboard",
    },
  } as unknown as Parameters<typeof testExports.resolveDirectToolCommand>[0]);

  assert.deepEqual(command, {
    name: "generate_image",
    prompt: "draw a dashboard",
  });
});

test("resolveDirectToolCommand leaves generate_pptx slash commands on the agent workflow", () => {
  const command = testExports.resolveDirectToolCommand({
    command: {
      arguments: "生成 PPT 介绍费曼学习法",
      canonicalName: "/generate_pptx",
      description: "Generate PPTX",
      displayName: "Generate PPTX",
      kind: "tool",
      name: "/generate_pptx",
      skillSlug: "",
      toolName: "generate_pptx",
      workflow: {
        arguments: "生成 PPT 介绍费曼学习法",
        defaultTools: ["generate_pptx"],
        execution: "agent",
        kind: "tool_workflow",
        name: "/generate_pptx",
        permissionOverrides: {
          generate_pptx: "allow",
        },
        renderedPrompt: "",
        successCriteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "generate_pptx",
        },
      },
    },
    generatePptxTool: {
      enabled: true,
      generationMode: "editable_native",
    },
    messageContent: "[tool:generate_pptx](Generate PPTX) 生成 PPT",
    userMessage: {
      content: "[tool:generate_pptx](Generate PPTX) 生成 PPT",
    },
  } as unknown as Parameters<typeof testExports.resolveDirectToolCommand>[0]);

  assert.equal(command, null);
});

test("command success requires generated image artifact metadata", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "image",
        kind: "artifact",
        toolName: "generate_image",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: "Image artifact created.\nartifact_id: artifact-1",
          status: "completed",
          tool: "generate_image",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "image",
        kind: "artifact",
        toolName: "generate_image",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output:
            "Image artifact created.\nartifact_id: artifact-1\nartifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          status: "completed",
          tool: "generate_image",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command success accepts generated video presentation artifact metadata", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_url:
              "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            status: "ready",
            version_id: "version-1",
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command success accepts video presentation JSON content output", () => {
  const output = {
    content: JSON.stringify({
      type: "video_presentation_artifact_result",
      artifact_id: "artifact-1",
      artifact_url:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      file_name: "feynman.mp4",
      render_strategy: "frontend_remotion_project_to_video",
      status: "ready",
      title: "费曼学习法",
      version_id: "version-1",
    }),
  };

  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output,
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command success accepts queued video presentation output", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            type: "video_presentation_artifact_result",
            artifact_id: "artifact-1",
            artifact_url:
              "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            status: "pending",
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command success accepts LangChain-wrapped queued video presentation output", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "call-af72256f",
          input: {},
          output: {
            id: ["langchain_core", "messages", "ToolMessage"],
            lc: 1,
            type: "constructor",
            kwargs: {
              id: "run-1",
              name: "generate_video_presentation",
              status: "success",
              content: JSON.stringify({
                type: "video_presentation_artifact_result",
                artifact_id: "artifact-1",
                artifact_url:
                  "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
                file_name: "feynman.mp4",
                job_id: "video-presentation-render_artifact-1",
                narration_enabled: true,
                render_strategy: "frontend_remotion_project_to_video",
                status: "pending",
                title: "费曼学习法",
                video_download_only: true,
              }),
              tool_call_id: "call-af72256f",
            },
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("command success rejects video presentation output without artifact url", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "video_presentation",
        kind: "artifact",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            content: JSON.stringify({
              type: "video_presentation_artifact_result",
              artifact_id: "artifact-1",
              status: "pending",
            }),
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    false,
  );
});

test("video presentation progress events normalize to generated video tool", () => {
  assert.deepEqual(
    testExports.normalizeGeneratedVideoPresentationProgressEvent({
      type: "generate_video_presentation_progress",
      toolCallId: "tool-1",
      stage: "generating_audio",
    }),
    {
      toolCallId: "tool-1",
      tool: "generate_video_presentation",
      data: {
        type: "generate_video_presentation_progress",
        toolCallId: "tool-1",
        tool: "generate_video_presentation",
        stage: "generating_audio",
      },
    },
  );
});

test("raw textual tool calls are suppressed while command success is pending", () => {
  assert.equal(
    testExports.shouldSuppressRawToolCallText({
      assistantContent: "",
      criteria: {
        artifactType: "slides",
        kind: "artifact",
        toolName: "generate_pptx",
      },
      delta: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="generate_pptx">',
      suppressing: false,
    }),
    true,
  );
  assert.equal(
    testExports.shouldSuppressRawToolCallText({
      assistantContent: "",
      criteria: {
        artifactType: "slides",
        kind: "artifact",
        toolName: "generate_pptx",
      },
      delta: "普通回答",
      suppressing: false,
    }),
    false,
  );
  assert.equal(
    testExports.shouldSuppressRawToolCallText({
      assistantContent: "前置说明",
      criteria: {
        artifactType: "slides",
        kind: "artifact",
        toolName: "generate_pptx",
      },
      delta: '<｜DSML｜tool_calls>',
      suppressing: false,
    }),
    false,
  );
});

test("messages stream handler suppresses raw tool call text and keeps suppression active", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-raw-tool-call" } as never,
  });

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: '<tool_call name="generate_pptx">',
      },
    ],
    commandSuccessCriteria: {
      artifactType: "slides",
      kind: "artifact",
      toolName: "generate_pptx",
    },
    runtime,
    suppressModelReasoning: false,
  });
  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: '{"topic":"hidden"}',
      },
    ],
    commandSuccessCriteria: {
      artifactType: "slides",
      kind: "artifact",
      toolName: "generate_pptx",
    },
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, []);
  assert.equal(runtime.suppressRawToolCallText, true);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.hasStreamedText, false);
});

test("messages stream handler clears streamed text when leaked artifact specs appear", async () => {
  const runtime = createTurnRuntime({
    prepared: { runTraceId: "trace-leaked-spec" } as never,
  });
  const criteria = {
    artifactType: "slides" as const,
    kind: "artifact" as const,
    toolName: "generate_pptx",
  };

  const firstEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: "Planning deck: ",
      },
    ],
    commandSuccessCriteria: criteria,
    runtime,
    suppressModelReasoning: false,
  });
  const secondEvents = await collectMessageStreamEvents({
    payload: [
      {
        role: "assistant",
        content: "artifact_url: /artifact-preview?artifactId=artifact-1",
      },
    ],
    commandSuccessCriteria: criteria,
    runtime,
    suppressModelReasoning: false,
  });

  assert.deepEqual(
    firstEvents.map((event) => event.type),
    ["text-delta"],
  );
  assert.deepEqual(secondEvents, [{ type: "text-replace", text: "" }]);
  assert.equal(runtime.suppressLeakedCommandSpecText, true);
  assert.equal(runtime.assistantContent, "");
  assert.equal(runtime.hasStreamedText, false);
  assert.equal(runtime.hasTextSinceLastToolBoundary, false);
});

test("presentation artifact trace labels needs_content without claiming artifact creation", () => {
  const output = {
    content: JSON.stringify({
      type: "presentation_artifact_input_required",
      status: "needs_content",
      title: "费曼学习法",
    }),
  };

  assert.equal(
    testExports.getFilesystemToolEndTitle("generate_pptx", {}, output),
    "Deck content needed",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "generate_pptx",
      {
        resultType: "presentation_artifact_input_required",
        status: "needs_content",
      },
      {},
    ),
    "The deck tool needs explicit slide content before it can create an artifact.",
  );
});

test("filesystem tool titles classify glob scope from mounted pattern", () => {
  assert.equal(
    testExports.getFilesystemToolStartTitle("glob", {
      path: "/",
      pattern: "/work/**/*.md",
    }),
    "Finding matching Workfiles",
  );
  assert.equal(
    testExports.getFilesystemToolEndTitle("glob", {
      path: "/",
      pattern: "/skills/**/*.md",
    }),
    "Found matching skill files",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/work/notes.md" },
    ),
    "Read 1 Workfile chunk.",
  );
  assert.equal(
    testExports.getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/kb/source.md", limit: 100 },
    ),
    "Read up to 100 source lines.",
  );
});

test("runtime prompt maps selected source mention labels to kb paths", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: [],
    selectedSources: [
      {
        sourceId: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        sourceType: "file_upload",
        parentSourceId: null,
        title: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        fileName: "043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
        safeName: "043e27f7-c8e0-438e-a47f-adcf8b06088e",
        shortId: "043e27f7",
        filePath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7.md",
        dirPath: "/kb/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7",
        readmePath: null,
        chunkCount: 4,
        sizeBytes: 12000,
        mimeType: "application/pdf",
        updatedAt: "2026-05-09T00:00:00.000Z",
      },
    ],
    selectedSourcesOmitted: 0,
  });

  assert.match(prompt, /<selected_source_manifest>/);
  assert.match(prompt, /@043e27f7-c8e0-438e-a47f-adcf8b06088e\.pdf/);
  assert.match(
    prompt,
    /kb_path="\/kb\/043e27f7-c8e0-438e-a47f-adcf8b06088e__src_043e27f7\.md"/,
  );
  assert.match(prompt, /Do not synthesize \/work\/<filename>/);
  assert.match(prompt, /\/work contains only thread Workfiles/);
});

test("runtime prompt lists only available public web tools", () => {
  const fetchOnlyPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_fetch"],
  });
  assert.match(
    fetchOnlyPrompt,
    /Available public web tools this turn: web_fetch\./,
  );
  assert.doesNotMatch(fetchOnlyPrompt, /web_search and web_fetch/);

  const searchAndFetchPrompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableWebTools: ["web_search", "web_fetch"],
  });
  assert.match(
    searchAndFetchPrompt,
    /Available public web tools this turn: web_search, web_fetch\./,
  );
});

test("runtime prompt preloads slash-invoked skill instructions", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "builtin",
        name: "feynman",
        version: "1.0.0",
        description: "Explain concepts in simple steps.",
        files: [
          {
            path: "SKILL.md",
            contentText:
              "Explain with simple analogies and check understanding.",
            mimeType: "text/markdown",
            sizeBytes: 40,
            contentHash: "hash",
          },
        ],
      },
    ],
    invokedSkillIds: ["skill-1"],
  });

  assert.match(prompt, /<user_invoked_skills>/);
  assert.match(prompt, /name="feynman"/);
  assert.match(prompt, /skill_path="\/skills\/feynman\/SKILL\.md"/);
  assert.match(prompt, /strong instruction, not a suggestion/);
  assert.match(
    prompt,
    /Explain with simple analogies and check understanding\./,
  );
});

test("extracts generated image artifacts from completed tool calls", () => {
  const artifacts = testExports.extractGeneratedImageArtifacts([
    {
      id: "tool-1",
      tool: "generate_image",
      input: {},
      output: {
        content:
          "Image artifact created.\nartifact_id: artifact-1\ntitle: Concept [draft]\nartifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      },
      sequence: 1,
      status: "completed",
      latencyMs: 100,
      error: null,
    },
  ]);

  assert.deepEqual(artifacts, [
    {
      artifactId: "artifact-1",
      artifactUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      title: "Concept [draft]",
      toolCallId: "tool-1",
    },
  ]);
});

test("normalizes generated image custom progress events", () => {
  assert.deepEqual(
    normalizeGeneratedImageProgressEvent({
      type: "generate_image_progress",
      toolCallId: "tool-1",
      tool: "web_search",
      stage: "generating",
    }),
    {
      toolCallId: "tool-1",
      tool: "generate_image",
      data: {
        type: "generate_image_progress",
        toolCallId: "tool-1",
        tool: "generate_image",
        stage: "generating",
      },
    },
  );

  assert.equal(
    normalizeGeneratedImageProgressEvent({
      type: "other_event",
      toolCallId: "tool-1",
    }),
    null,
  );
});

test("builds generated image render blocks in event order", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Intro\n");
  builder.appendGeneratedImage("tool-1");
  builder.appendText("\nDetails");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Intro\n\nDetails",
    }),
    [
      {
        id: "text-1",
        type: "text",
        text: "Intro\n",
      },
      {
        id: "generated-image-tool-1",
        type: "generated_image",
        toolCallId: "tool-1",
      },
      {
        id: "text-2",
        type: "text",
        text: "\nDetails",
      },
    ],
  );
});

test("builds generic tool render blocks in event order", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Before tool");
  builder.appendTool("tool-1");
  builder.appendText("After tool");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Before toolAfter tool",
    }),
    [
      {
        id: "text-1",
        type: "text",
        text: "Before tool",
      },
      {
        id: "tool-tool-1",
        type: "tool",
        toolCallId: "tool-1",
      },
      {
        id: "text-2",
        type: "text",
        text: "After tool",
      },
    ],
  );
});

test("builds generated presentation render blocks in event order", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Intro\n");
  builder.appendGeneratedPresentation("tool-1");
  builder.appendText("\nHere is the deck summary.");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Intro\n\nHere is the deck summary.",
    }),
    [
      {
        id: "text-1",
        type: "text",
        text: "Intro\n",
      },
      {
        id: "generated-presentation-tool-1",
        type: "generated_presentation",
        toolCallId: "tool-1",
      },
      {
        id: "text-2",
        type: "text",
        text: "\nHere is the deck summary.",
      },
    ],
  );
});

test("can clear leaked planning text while preserving generated artifact blocks", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText('{"schemaVersion":1,"slides":[]}');
  builder.appendGeneratedPresentation("tool-1");
  builder.replaceText("");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "",
    }),
    [
      {
        id: "generated-presentation-tool-1",
        type: "generated_presentation",
        toolCallId: "tool-1",
      },
    ],
  );
});

test("preserves render blocks when final text diverges", () => {
  const builder = testExports.createMessageRenderBlockBuilder();

  builder.appendText("Before citation [citation:missing]");
  builder.appendGeneratedImage("tool-1");

  assert.deepEqual(
    testExports.finalizeMessageRenderBlocks({
      blocks: builder.list(),
      finalText: "Before citation",
    }),
    [
      {
        id: "text-1",
        type: "text",
        text: "Before citation [citation:missing]",
      },
      {
        id: "generated-image-tool-1",
        type: "generated_image",
        toolCallId: "tool-1",
      },
    ],
  );
});

test("command success accepts structured presentation artifact output", () => {
  assert.equal(
    testExports.isCommandSuccessSatisfied({
      criteria: {
        artifactType: "slides",
        kind: "artifact",
        toolName: "generate_pptx",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_id: "artifact-1",
            artifact_url: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            title: "费曼学习法",
          },
          status: "completed",
          tool: "generate_pptx",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    true,
  );
});

test("runtime prompt treats image auto mode as available but optional", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_image"],
    artifactIntent: {
      kind: "image",
      shouldInjectTool: true,
      source: "explicit_tool",
      confidence: 0.55,
      reason:
        "User-facing image generation controls configured generate_image.",
      config: {
        aspectRatio: "auto",
        quality: "auto",
        style: "auto",
      },
      warnings: [],
    },
  });

  assert.match(prompt, /generate_image is available in auto mode/);
  assert.match(prompt, /decide semantically from the user's goal/);
  assert.match(prompt, /Never claim an image was created/);
  assert.match(prompt, /do not include image markdown or raw artifact URLs/);
  assert.match(prompt, /otherwise answer normally/);
});

test("runtime prompt keeps PPTX design settings out of visible slide copy", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_pptx"],
    generatePptxTool: {
      enabled: true,
      generationMode: "visual_html",
      design: {
        aspectRatio: "16:9",
        language: "zh",
        stylePreset: "editorial",
      },
    },
  });

  assert.match(prompt, /PPTX design defaults: style_preset=editorial/);
  assert.match(prompt, /complete DeckSpec-style plan/);
  assert.match(prompt, /narrative arc, claim spine, slide mix/);
  assert.match(prompt, /Do not use a fixed slide sequence/);
  assert.match(prompt, /internal tool configuration only/);
  assert.match(prompt, /do not use them as visible slide titles/);
  assert.match(prompt, /Provide visible text explicitly through content\.cover fields/);
  assert.match(prompt, /never concatenate serialized JSON, sibling fields, arrays/);
  assert.match(prompt, /renderer does not invent missing subtitles/);
  assert.match(prompt, /templateArtifactId is present/);
  assert.match(prompt, /unless the user explicitly wrote that wording as content/);
});

test("runtime prompt uses editable-native object hygiene appendix only for editable PPTX", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_pptx"],
    generatePptxTool: {
      enabled: true,
      generationMode: "editable_native",
      design: {
        aspectRatio: "16:9",
        language: "zh",
        stylePreset: "executive",
      },
    },
  });

  assert.match(prompt, /audience goal, narrative arc, claim spine/);
  assert.match(prompt, /only objects consumed by visible content/);
  assert.match(prompt, /blank cards, unused placeholders, empty media frames/);
  assert.doesNotMatch(prompt, /motion, section curtains, data posters/);
});

test("runtime prompt normalizes legacy visual-html selection to editable PPTX guidance", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_pptx"],
    generatePptxTool: {
      enabled: true,
      generationMode: "visual_html",
    },
  });

  assert.match(prompt, /audience goal, narrative arc, claim spine/);
  assert.match(prompt, /high_quality_editable_pptx/);
  assert.match(prompt, /Legacy generation mode requested: visual_html/);
  assert.match(prompt, /only objects consumed by visible content/);
  assert.match(prompt, /blank cards, unused placeholders/);
  assert.doesNotMatch(prompt, /motion, section curtains, data posters/);
});

test("runtime prompt keeps video presentation settings out of visible copy and narration", () => {
  const prompt = testExports.buildAgentRuntimePrompt({
    timezone: "UTC",
    availableArtifactTools: ["generate_video_presentation"],
    generateVideoPresentationTool: {
      enabled: true,
      narration: { enabled: true },
    },
  });

  assert.match(prompt, /trusted Remotion video project/);
  assert.match(prompt, /browser previews the project and renders the final video/);
  assert.doesNotMatch(prompt, /queues server-side MP4 rendering/);
  assert.match(prompt, /choose a concise video title/);
  assert.match(prompt, /user_prompt/);
  assert.match(prompt, /Do not expose PPTX style presets or deck configuration/);
  assert.match(prompt, /never provide raw TSX or executable code/);
  assert.match(prompt, /Narration defaults to on/);
  assert.match(prompt, /short status/);
  assert.doesNotMatch(prompt, /being prepared or is ready/);
  assert.doesNotMatch(prompt, /ready for preview\/download/);
  assert.match(prompt, /project has been created and is preparing assets/);
  assert.match(prompt, /Do not say "the video has been generated"/);
  assert.match(prompt, /final video\/MP4 has already been rendered/);
});

test("tool commands bind only the requested artifact tool", () => {
  const prepared = {
    command: {
      kind: "tool",
      toolName: "generate_video_presentation",
    },
  } as unknown as Parameters<typeof testExports.shouldBindAgentTool>[0]["prepared"];

  assert.equal(
    testExports.shouldBindAgentTool({
      prepared,
      toolName: "generate_video_presentation",
    }),
    true,
  );
  assert.equal(
    testExports.shouldBindAgentTool({
      prepared,
      toolName: "generate_pptx",
    }),
    false,
  );
});

test("non-command turns bind only default artifact tools", () => {
  const prepared = { command: null } as unknown as Parameters<
    typeof testExports.shouldBindAgentTool
  >[0]["prepared"];

  assert.equal(
    testExports.shouldBindAgentTool({
      prepared,
      toolName: "generate_pptx",
    }),
    true,
  );
  assert.equal(
    testExports.shouldBindAgentTool({
      prepared,
      toolName: "generate_video_presentation",
    }),
    false,
  );
});
