import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import { resolveAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
import { tool } from "langchain";
import { afterEach, test, vi } from "vitest";
import { z } from "zod";
import {
  AGENT_TOOL_EXECUTION_TIMEOUT_CODE,
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  AgentToolExecutionTimeoutError,
  AgentToolTerminationUnknownError,
  createSourceWeftToolExecutionTimeoutMiddleware,
  isAgentToolExecutionTimeoutReason,
} from "./tool-execution-timeout";
import { currentSourceWeftToolInvocationSignal } from "./tool-call-context";

type MiddlewareWithWrapToolCall = {
  wrapToolCall?: (
    request: any,
    handler: (request: any) => unknown | Promise<unknown>,
  ) => Promise<unknown>;
};

function wrapToolCallHook(middleware: unknown) {
  const hook = (middleware as MiddlewareWithWrapToolCall).wrapToolCall;
  if (!hook) throw new Error("Expected wrapToolCall hook");
  return hook;
}

function request(input: {
  args?: Record<string, unknown>;
  signal?: AbortSignal;
  tool?: unknown;
  toolName?: string;
}) {
  return {
    runtime: input.signal ? { signal: input.signal } : {},
    state: { messages: [] },
    tool: input.tool,
    toolCall: {
      args: input.args ?? {},
      id: "call-timeout",
      name: input.toolName ?? "test_tool",
    },
  };
}

function result() {
  return new ToolMessage({
    content: "ok",
    name: "test_tool",
    tool_call_id: "call-timeout",
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

test("passes one merged signal through runtime and the Host configurable side channel", async () => {
  const schema = { kind: "schema" };
  let invokeSignal: AbortSignal | undefined;
  let langChainSignal: AbortSignal | undefined;

  class PrivateTool {
    readonly name = "declared_tool";
    readonly returnDirect = true;
    readonly schema = schema;
    #result = "private-ok";

    invoke(_input: unknown, config?: { signal?: AbortSignal }) {
      langChainSignal = config?.signal;
      invokeSignal = resolveAgentToolHostInvocationSignal(config);
      return this.#result;
    }
  }

  const originalTool = new PrivateTool();
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    resolveDefinition: () => ({
      id: "declaredTool",
      executionTimeoutMs: 5_000,
    }),
  });

  const output = await wrapToolCallHook(middleware)(
    request({
      // Model-authored timeout-like arguments have no policy authority.
      args: { timeout: 1, timeoutMs: 1 },
      tool: originalTool,
      toolName: originalTool.name,
    }),
    async (modified) => {
      assert.ok(modified.runtime.signal instanceof AbortSignal);
      assert.ok(modified.tool instanceof PrivateTool);
      assert.equal(modified.tool.name, originalTool.name);
      assert.equal(modified.tool.schema, schema);
      assert.equal(modified.tool.returnDirect, true);
      assert.equal(
        await modified.tool.invoke(
          {},
          {
            configurable: { thread_id: "thread-1" },
            signal: new AbortController().signal,
          },
        ),
        "private-ok",
      );
      assert.equal(invokeSignal, modified.runtime.signal);
      assert.equal(langChainSignal, undefined);
      return result();
    },
  );

  assert.ok(ToolMessage.isInstance(output));
  assert.equal(output.content, "ok");
});

test("binds the same invocation signal for Deep Agents backend calls without ToolRuntime", async () => {
  let runtimeSignal: AbortSignal | undefined;
  let backendSignal: AbortSignal | undefined;
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    resolveDefinition: () => ({
      id: "backendTool",
      executionTimeoutMs: 5_000,
    }),
  });

  await wrapToolCallHook(middleware)(request({}), async (next) => {
    runtimeSignal = next.runtime.signal as AbortSignal;
    await Promise.resolve();
    backendSignal = currentSourceWeftToolInvocationSignal();
    return result();
  });

  assert.ok(runtimeSignal instanceof AbortSignal);
  assert.equal(backendSignal, runtimeSignal);
  assert.equal(currentSourceWeftToolInvocationSignal(), undefined);
});

test("uses the 120s default for an undeclared tool and exposes a stable timeout reason", async () => {
  vi.useFakeTimers();
  let observedReason: unknown;
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 1_000,
    resolveDefinition: () => null,
  });

  const invocation = wrapToolCallHook(middleware)(
    request({ args: { timeoutMs: 60 * 60_000 } }),
    async (next) => {
      const signal = next.runtime.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedReason = signal.reason;
            resolve();
          },
          { once: true },
        );
      });
      return result();
    },
  );
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(119_999);
  assert.equal(observedReason, undefined);
  await vi.advanceTimersByTimeAsync(1);

  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof AgentToolExecutionTimeoutError);
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.code, AGENT_TOOL_EXECUTION_TIMEOUT_CODE);
    assert.equal(error.timeoutMs, 120_000);
    assert.equal(error.toolName, "test_tool");
    assert.equal(error, observedReason);
    assert.ok(isAgentToolExecutionTimeoutReason(error));
    return true;
  });
});

test("clamps a declared timeout to the 10m host maximum", async () => {
  vi.useFakeTimers();
  let signalReason: unknown;
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 1_000,
    resolveDefinition: () => ({
      id: "longTool",
      executionTimeoutMs: 15 * 60_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(request({}), async (next) => {
    const signal = next.runtime.signal as AbortSignal;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          signalReason = signal.reason;
          resolve();
        },
        { once: true },
      ),
    );
    return result();
  });
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof AgentToolExecutionTimeoutError);
    assert.equal(error.timeoutMs, 10 * 60_000);
    assert.equal(error, signalReason);
    return true;
  });
});

test("aborts at the deadline but waits for handler cleanup before reporting timeout", async () => {
  vi.useFakeTimers();
  let releaseCleanup!: () => void;
  let cleanupStarted = false;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 5_000,
    resolveDefinition: () => ({
      id: "cleanupTool",
      executionTimeoutMs: 1_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(request({}), async (next) => {
    const signal = next.runtime.signal as AbortSignal;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          cleanupStarted = true;
          resolve();
        },
        { once: true },
      ),
    );
    await cleanup;
    return result();
  });
  let settled = false;
  void invocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(cleanupStarted, true);
  assert.equal(settled, false);

  releaseCleanup();
  await assert.rejects(invocation, AgentToolExecutionTimeoutError);
  assert.equal(settled, true);
  assert.equal(vi.getTimerCount(), 0);
});

test("a real LangChain tool callback must finish cleanup before timeout settles", async () => {
  vi.useFakeTimers();
  let releaseCleanup!: () => void;
  let cleanupStarted = false;
  let cleanupFinished = false;
  let observedSignal: AbortSignal | undefined;
  let observedLangChainSignal: AbortSignal | undefined;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const actualTool = tool(
    async (_args, runtime) => {
      observedSignal = resolveAgentToolHostInvocationSignal(runtime);
      observedLangChainSignal = (runtime as { signal?: AbortSignal }).signal;
      assert.ok(observedSignal);
      await new Promise<void>((resolve) =>
        observedSignal!.addEventListener(
          "abort",
          () => {
            cleanupStarted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await cleanup;
      cleanupFinished = true;
      return "late-success";
    },
    {
      name: "real_cleanup_tool",
      description: "Timeout cleanup probe",
      schema: z.object({}),
    },
  );
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 5_000,
    resolveDefinition: () => ({
      id: "realCleanupTool",
      executionTimeoutMs: 1_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(
    request({ tool: actualTool, toolName: actualTool.name }),
    (next) =>
      next.tool.invoke(
        {
          args: {},
          id: "call-timeout",
          name: actualTool.name,
          type: "tool_call",
        },
        { signal: new AbortController().signal },
      ),
  );
  let settled = false;
  void invocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(observedLangChainSignal, undefined);
  assert.equal(cleanupStarted, true);
  assert.equal(cleanupFinished, false);
  assert.equal(settled, false);

  releaseCleanup();
  await assert.rejects(invocation, AgentToolExecutionTimeoutError);
  assert.equal(cleanupFinished, true);
  assert.equal(settled, true);
  assert.equal(vi.getTimerCount(), 0);
});

test("reports termination_unknown when cleanup does not settle within grace", async () => {
  vi.useFakeTimers();
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 500,
    resolveDefinition: () => ({
      id: "stuckTool",
      executionTimeoutMs: 1_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(request({}), async () => {
    await new Promise<never>(() => undefined);
    return result();
  });
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1_499);
  let settled = false;
  void invocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushMicrotasks();
  assert.equal(settled, false);

  await vi.advanceTimersByTimeAsync(1);
  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof AgentToolTerminationUnknownError);
    assert.equal(error.code, AGENT_TOOL_TERMINATION_UNKNOWN_CODE);
    assert.equal(error.terminationGraceMs, 500);
    assert.equal(error.toolName, "test_tool");
    assert.ok(isAgentToolExecutionTimeoutReason(error.cause));
    return true;
  });
});

test("a real LangChain tool that ignores abort becomes termination_unknown after grace", async () => {
  vi.useFakeTimers();
  const actualTool = tool(async () => new Promise<never>(() => undefined), {
    name: "real_stuck_tool",
    description: "Stuck timeout probe",
    schema: z.object({}),
  });
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 500,
    resolveDefinition: () => ({
      id: "realStuckTool",
      executionTimeoutMs: 1_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(
    request({ tool: actualTool, toolName: actualTool.name }),
    (next) =>
      next.tool.invoke(
        {
          args: {},
          id: "call-timeout",
          name: actualTool.name,
          type: "tool_call",
        },
        { signal: new AbortController().signal },
      ),
  );
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1_500);
  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof AgentToolTerminationUnknownError);
    assert.equal(error.code, AGENT_TOOL_TERMINATION_UNKNOWN_CODE);
    assert.equal(error.terminationGraceMs, 500);
    return true;
  });
});

test("preserves a sandbox termination_unknown rejection after timeout cleanup", async () => {
  vi.useFakeTimers();
  const sandboxTerminationUnknown = Object.assign(
    new Error("sandbox did not confirm termination"),
    { code: "SANDBOX_TERMINATION_UNKNOWN" },
  );
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 500,
    resolveDefinition: () => ({
      id: "sandboxTool",
      executionTimeoutMs: 1_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(request({}), async (next) => {
    const signal = next.runtime.signal as AbortSignal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw sandboxTerminationUnknown;
  });
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(1_000);
  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof AgentToolTerminationUnknownError);
    assert.equal(error.code, AGENT_TOOL_TERMINATION_UNKNOWN_CODE);
    assert.ok(isAgentToolExecutionTimeoutReason(error.cause));
    return true;
  });
});

test("caller cancellation is forwarded unchanged and never relabeled as timeout", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const callerReason = new DOMException("user stopped", "AbortError");
  let toolReason: unknown;
  const middleware = createSourceWeftToolExecutionTimeoutMiddleware({
    terminationGraceMs: 1_000,
    resolveDefinition: () => ({
      id: "cancelledTool",
      executionTimeoutMs: 5_000,
    }),
  });

  const invocation = wrapToolCallHook(middleware)(
    request({ signal: caller.signal }),
    async (next) => {
      const signal = next.runtime.signal as AbortSignal;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            toolReason = signal.reason;
            resolve();
          },
          { once: true },
        ),
      );
      return result();
    },
  );
  void invocation.catch(() => undefined);

  await flushMicrotasks();
  caller.abort(callerReason);
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(error, callerReason);
    assert.equal(error, toolReason);
    assert.equal(isAgentToolExecutionTimeoutReason(error), false);
    return true;
  });
  assert.equal(vi.getTimerCount(), 0);
});
