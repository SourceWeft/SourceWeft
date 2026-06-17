import assert from "node:assert/strict";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { test, vi } from "vitest";
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

type MiddlewareWithWrapToolCall = {
  wrapToolCall?: (
    request: unknown,
    handler: (request: unknown) => unknown | Promise<unknown>,
  ) => unknown | Promise<unknown>;
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
    });

    assert.deepEqual(
      stack.slice(0, 4).map((middleware) => middleware.name),
      [
        "SourceWeftImageHistorySanitizer",
        "SourceWeftKnowledgeFilesystemDescriptions",
        "SourceWeftCommandToolChoice",
        "SourceWeftToolObservability",
      ],
    );
  } finally {
    if (previousCompaction === undefined) {
      delete process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED;
    } else {
      process.env.SOURCEWEFT_AGENT_COMPACTION_ENABLED = previousCompaction;
    }
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

test("command tool choice forces the target tool on the first model call", async () => {
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
  const requests: Array<{ toolChoice?: unknown; tools: unknown[] }> = [];

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
