import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { tool } from "langchain";
import { test, vi } from "vitest";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";

vi.mock("./context-compression", () => ({
  createSourceWeftContextCompressionMiddleware: vi.fn(async () => [
    { name: "SourceWeftContextCompressionTrace" },
  ]),
}));

vi.mock("../../../llm-observability", () => ({
  endSpan: vi.fn(),
  startSpan: vi.fn(),
}));

import {
  createCommandToolChoiceMiddleware,
  createKnowledgeFilesystemToolDescriptionMiddleware,
  createSourceWeftAgentMiddlewareStack,
  createSourceWeftImageHistorySanitizerMiddleware,
  createSourceWeftToolObservabilityMiddleware,
  forcedToolChoice,
  sanitizeMessagesForHistory,
} from ".";

type MiddlewareWithAfterAgent = {
  afterAgent?: (state: unknown) => unknown | Promise<unknown>;
};

type MiddlewareWithAfterModel = {
  afterModel?:
    | ((state: unknown, runtime?: unknown) => unknown | Promise<unknown>)
    | {
        hook: (state: unknown, runtime?: unknown) => unknown | Promise<unknown>;
      };
};

type MiddlewareWithWrapToolCall = {
  // Always awaited by callers, so the hook is typed as returning a promise —
  // `unknown | Promise<unknown>` collapses to `unknown` and breaks
  // assert.rejects at the call site.
  wrapToolCall?: (
    request: unknown,
    handler: (request: unknown) => unknown | Promise<unknown>,
  ) => Promise<unknown>;
};

type MiddlewareWithWrapModelCall = {
  wrapModelCall?: (
    request: unknown,
    handler: (request: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => unknown | Promise<unknown>;
};

function afterAgentHook(middleware: unknown) {
  const hook = (middleware as MiddlewareWithAfterAgent).afterAgent;
  if (typeof hook !== "function") {
    throw new Error("Expected afterAgent hook");
  }
  return hook;
}

function afterModelHook(middleware: unknown) {
  const hook = (middleware as MiddlewareWithAfterModel).afterModel;
  if (typeof hook === "function") {
    return hook;
  }
  if (hook && typeof hook === "object" && typeof hook.hook === "function") {
    return hook.hook;
  }
  throw new Error("Expected afterModel hook");
}

function wrapModelCallHook(middleware: unknown) {
  const hook = (middleware as MiddlewareWithWrapModelCall).wrapModelCall;
  if (typeof hook !== "function") {
    throw new Error("Expected wrapModelCall hook");
  }
  return hook;
}

function wrapToolCallHook(middleware: unknown) {
  const hook = (middleware as MiddlewareWithWrapToolCall).wrapToolCall;
  if (typeof hook !== "function") {
    throw new Error("Expected wrapToolCall hook");
  }
  return hook;
}

test("middleware stack keeps SourceWeft middleware order stable", async () => {
  const previousCompaction = process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
  process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = "0";

  try {
    const stack = await createSourceWeftAgentMiddlewareStack({
      modelAlias: "chat-default",
      filesystemMounts: [],
      commandExecutionPolicy: { targetToolName: "target_tool" },
      extraMiddleware: [{ name: "ExtraMiddleware" }],
    });

    const expectedMiddlewareOrder = [
      "SourceWeftImageHistorySanitizer",
      "SourceWeftKnowledgeFilesystemDescriptions",
      "SourceWeftCommandToolChoice",
      "SourceWeftToolObservability",
      "toolRetryMiddleware",
      "SourceWeftContextCompressionTrace",
      "modelRetryMiddleware",
      "ToolCallLimitMiddleware",
      "ExtraMiddleware",
    ];

    assert.deepEqual(
      stack
        .slice(0, expectedMiddlewareOrder.length)
        .map((middleware) => middleware.name),
      expectedMiddlewareOrder,
    );
  } finally {
    if (previousCompaction === undefined) {
      delete process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
    } else {
      process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = previousCompaction;
    }
  }
});

test("tool retry only wraps safe read-only tools", async () => {
  const stack = await createSourceWeftAgentMiddlewareStack({
    modelAlias: "chat-default",
    filesystemMounts: [],
  });
  const middleware = stack.find((item) => item.name === "toolRetryMiddleware");
  assert.ok(middleware);

  let readAttempts = 0;
  const readResult = await wrapToolCallHook(middleware)(
    {
      toolCall: {
        id: "call-read",
        name: AGENT_TOOL_NAMES.readFile,
        args: {},
      },
    },
    async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        throw new Error("temporary read failure");
      }
      return new ToolMessage({
        content: "ok",
        name: AGENT_TOOL_NAMES.readFile,
        tool_call_id: "call-read",
      });
    },
  );

  assert.ok(ToolMessage.isInstance(readResult));
  assert.equal(readAttempts, 2);

  let executeAttempts = 0;
  await assert.rejects(
    wrapToolCallHook(middleware)(
      {
        toolCall: {
          id: "call-execute",
          name: AGENT_TOOL_NAMES.execute,
          args: {},
        },
      },
      async () => {
        executeAttempts += 1;
        throw new Error("execute failed");
      },
    ),
    /execute failed/,
  );
  assert.equal(executeAttempts, 1);
});

test("tool call limit blocks calls beyond the configured run limit", async () => {
  const originalAgentConfig = { ...config.chat.agent };

  try {
    config.chat.agent.toolCallRunLimit = 2;
    config.chat.agent.toolCallThreadLimit = 10;

    const stack = await createSourceWeftAgentMiddlewareStack({
      modelAlias: "chat-default",
      filesystemMounts: [],
    });
    const middleware = stack.find(
      (item) => item.name === "ToolCallLimitMiddleware",
    );
    assert.ok(middleware);

    const update = await afterModelHook(middleware)({
      messages: [
        new HumanMessage("Use tools"),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "search_sources", args: {} },
            { id: "call-2", name: "search_sources", args: {} },
            { id: "call-3", name: "search_sources", args: {} },
          ],
        }),
      ],
      threadToolCallCount: {},
      runToolCallCount: {},
    });

    const messages = (update as { messages?: unknown[] }).messages ?? [];
    assert.equal(messages.length, 1);
    const blocked = messages[0];
    assert.ok(ToolMessage.isInstance(blocked));
    const blockedToolMessage = blocked as ToolMessage;
    assert.equal(blockedToolMessage.tool_call_id, "call-3");
    assert.equal(blockedToolMessage.name, "search_sources");
    assert.equal(
      blockedToolMessage.content,
      "Tool call limit exceeded. Do not make additional tool calls.",
    );
    assert.deepEqual(
      (update as { threadToolCallCount?: unknown }).threadToolCallCount,
      {
        __all__: 2,
      },
    );
    assert.deepEqual(
      (update as { runToolCallCount?: unknown }).runToolCallCount,
      {
        __all__: 3,
      },
    );
  } finally {
    Object.assign(config.chat.agent, originalAgentConfig);
  }
});

test("image history sanitizer replaces image blocks with text placeholders", async () => {
  const imageMessage = new HumanMessage({
    content: [
      { type: "text", text: "please inspect this" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,abc",
        },
      },
    ],
  });

  const sanitized = sanitizeMessagesForHistory([imageMessage]);

  assert.equal(sanitized.changed, true);
  assert.deepEqual((sanitized.messages[0] as HumanMessage).content, [
    { type: "text", text: "please inspect this" },
    {
      type: "text",
      text: "[attached image 1: image, omitted from conversation history]",
    },
  ]);

  const middleware = createSourceWeftImageHistorySanitizerMiddleware();
  const update = await afterAgentHook(middleware)({
    messages: [imageMessage],
  });

  assert.ok(update);
  assert.equal((update as { messages: unknown[] }).messages.length, 2);
});

test("filesystem description middleware rewrites mounted filesystem tool descriptions", async () => {
  const middleware = createKnowledgeFilesystemToolDescriptionMiddleware({
    mounts: [],
  });
  const readFile = {
    name: "read_file",
    description: "old description",
  };
  const untouched = {
    name: "custom_tool",
    description: "custom description",
  };
  let requestTools: Array<{ description?: string; name: string }> = [];

  await wrapModelCallHook(middleware)(
    {
      tools: [readFile, untouched],
    },
    async (request) => {
      requestTools = request.tools as typeof requestTools;
      return {} as never;
    },
  );

  assert.equal(requestTools[0]?.name, "read_file");
  assert.notEqual(requestTools[0]?.description, "old description");
  assert.match(requestTools[0]?.description ?? "", /read/i);
  assert.equal(requestTools[1]?.description, "custom description");
});

test("command tool choice forces non-video targets without changing parallel tool calls", async () => {
  const middleware = createCommandToolChoiceMiddleware({
    targetToolName: "target_tool",
  });
  const targetTool = tool(async () => "ok", {
    name: "target_tool",
    description: "Target",
  });
  const otherTool = tool(async () => "ignored", {
    name: "other_tool",
    description: "Other",
  });
  const requests: Array<{
    modelSettings?: Record<string, unknown>;
    toolChoice?: unknown;
    tools: unknown[];
  }> = [];

  await wrapModelCallHook(middleware)(
    {
      state: { messages: [] },
      tools: [otherTool, targetTool],
    },
    async (request) => {
      requests.push(request as never);
      return {
        tool_calls: [
          {
            id: "call-1",
            name: "target_tool",
            args: {},
          },
        ],
      } as never;
    },
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0]?.tools.map((item) => (item as { name: string }).name),
    ["target_tool"],
  );
  assert.deepEqual(requests[0]?.toolChoice, forcedToolChoice("target_tool"));
  assert.equal(requests[0]?.modelSettings, undefined);
});

test("command tool choice disables parallel calls only for explicit video presentation commands", async () => {
  const middleware = createCommandToolChoiceMiddleware({
    targetToolName: "generate_video_presentation",
  });
  const targetTool = tool(async () => "ok", {
    name: "generate_video_presentation",
    description: "Generate video presentation",
  });
  const requests: Array<Record<string, unknown>> = [];

  await wrapModelCallHook(middleware)(
    {
      modelSettings: { headers: { "x-test": "preserved" } },
      state: { messages: [] },
      tools: [targetTool],
    },
    async (request) => {
      requests.push(request);
      return {
        tool_calls: [
          {
            id: "call-video",
            name: "generate_video_presentation",
            args: {},
          },
        ],
      } as never;
    },
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.modelSettings, {
    headers: { "x-test": "preserved" },
    parallel_tool_calls: false,
  });
});

test("tool observability logs start and completion", async () => {
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const middleware = createSourceWeftToolObservabilityMiddleware({
    context: {
      runId: "run-1",
      teamId: "team-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
    },
  });

  try {
    const result = await wrapToolCallHook(middleware)(
      {
        toolCall: {
          id: "call-1",
          name: "target_tool",
          args: { secret: "input is not logged" },
        },
      },
      async () =>
        new ToolMessage({
          content: "ok",
          name: "target_tool",
          tool_call_id: "call-1",
        }),
    );

    assert.ok(ToolMessage.isInstance(result));
    assert.equal(infoSpy.mock.calls.length, 2);
    assert.equal(infoSpy.mock.calls[0]?.[0], "agent.tool.started");
    assert.equal(infoSpy.mock.calls[1]?.[0], "agent.tool.completed");
    assert.deepEqual(infoSpy.mock.calls[0]?.[1], {
      event: "agent.tool.started",
      toolName: "target_tool",
      toolCallId: "call-1",
      threadId: "thread-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      userId: "user-1",
      runId: "run-1",
      status: "running",
    });
    assert.equal(
      (infoSpy.mock.calls[1]?.[1] as Record<string, unknown>).status,
      "completed",
    );
  } finally {
    infoSpy.mockRestore();
  }
});

test("tool observability logs thrown tool errors", async () => {
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const errorSpy = vi
    .spyOn(logger, "error")
    .mockImplementation(() => undefined);
  const middleware = createSourceWeftToolObservabilityMiddleware();
  const wrapToolCall = wrapToolCallHook(middleware);
  const error = new Error("boom");

  try {
    await wrapToolCall(
      {
        toolCall: {
          id: "call-error",
          name: "target_tool",
          args: {},
        },
      },
      async () => {
        throw error;
      },
    );
    assert.fail("Expected tool error");
  } catch (caught) {
    assert.strictEqual(caught, error);

    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal(errorSpy.mock.calls[0]?.[0], "agent.tool.failed");
    const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(metadata.toolName, "target_tool");
    assert.equal(metadata.toolCallId, "call-error");
    assert.equal(metadata.status, "error");
    assert.deepEqual(metadata.error, {
      name: "Error",
      message: "Tool execution failed.",
    });
  } finally {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("tool observability logs execute failure diagnostics without raw command", async () => {
  const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const errorSpy = vi
    .spyOn(logger, "error")
    .mockImplementation(() => undefined);
  const middleware = createSourceWeftToolObservabilityMiddleware({
    context: { runId: "run-context" },
  });

  try {
    const result = await wrapToolCallHook(middleware)(
      {
        toolCall: {
          id: "call-execute",
          name: "execute",
          args: { command: "printf 'a\nb'" },
        },
      },
      async () => ({
        content: [
          "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
          "Hint: Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
          "Diagnostics: toolName=execute commandFingerprint=sha256:abc failureCode=SANDBOX_EXECUTE_COMMAND_DENIED repeatCount=2 runId=run-1",
          "[Command failed with exit code 1]",
        ].join("\n"),
        status: "error",
      }),
    );

    assert.deepEqual(result, {
      content: [
        "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
        "Hint: Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
        "Diagnostics: toolName=execute commandFingerprint=sha256:abc failureCode=SANDBOX_EXECUTE_COMMAND_DENIED repeatCount=2 runId=run-1",
        "[Command failed with exit code 1]",
      ].join("\n"),
      status: "error",
    });
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal(errorSpy.mock.calls[0]?.[0], "agent.tool.failed");
    const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(metadata.toolName, "execute");
    assert.equal(metadata.toolCallId, "call-execute");
    assert.equal(metadata.status, "error");
    assert.equal(metadata.commandFingerprint, "sha256:abc");
    assert.equal(metadata.failureCode, "SANDBOX_EXECUTE_COMMAND_DENIED");
    assert.equal(metadata.repeatCount, 2);
    assert.equal(metadata.runId, "run-1");
    assert.equal(
      metadata.failureMessage,
      "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
    );
    assert.equal(
      metadata.failureHint,
      "Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
    );
    assert.equal(JSON.stringify(metadata).includes("printf"), false);
    assert.deepEqual(metadata.error, {
      message: "Tool execution failed.",
    });
  } finally {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  }
});
