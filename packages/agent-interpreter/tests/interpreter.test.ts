import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MessageChannel } from "node:worker_threads";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ReplSession } from "@langchain/quickjs";
import type { BackendProtocolV2 } from "deepagents";
import {
  createInterpreterExecutionGate,
  createSourceWeftInterpreterMiddleware,
  DEFAULT_INTERPRETER_LIMITS,
  InterpreterError,
  type InterpreterLimits,
} from "../src/index";
import { createInterpreterReadTools } from "../src/read-tools";

function limits(overrides: Partial<InterpreterLimits> = {}): InterpreterLimits {
  return { ...DEFAULT_INTERPRETER_LIMITS, ...overrides };
}

function pendingHostOperation(t: TestContext) {
  const { port1, port2 } = new MessageChannel();
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
    // A pending backend operation owns an I/O handle. A bare never-settling
    // Promise does not, so Node can exit before the gate's unref'ed deadline.
    port1.once("message", resolve);
  });
  t.after(() => {
    port1.close();
    port2.close();
    settle();
  });
  return () => pending;
}

function backendWithCalls(calls: string[]): BackendProtocolV2 {
  return {
    ls: async (path) => ({
      files: [
        { path: "/kb/", is_dir: true },
        { path: "/workfiles/", is_dir: true },
        { path: "/skills/", is_dir: true },
        { path: `${path}/visible.txt`, is_dir: false },
      ],
    }),
    read: async (path) => {
      calls.push(path);
      return { content: `content:${path}`, mimeType: "text/plain" };
    },
    readRaw: async () => ({ error: "not used" }),
    write: async () => ({ error: "read only" }),
    edit: async () => ({ error: "read only" }),
    grep: async (_pattern, path) => ({
      matches: [{ path: `${path}/match.txt`, line: 1, text: "match" }],
    }),
    glob: async (_pattern, path) => ({
      files: [{ path: `${path}/match.txt`, is_dir: false }],
    }),
  };
}

function toolByName(
  name: string,
  calls: string[] = [],
  limitOverrides: Partial<InterpreterLimits> = {},
) {
  const configuredLimits = limits(limitOverrides);
  const tools = createInterpreterReadTools({
    backend: backendWithCalls(calls),
    allowedTools: ["ls", "read_file", "glob", "grep"],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-test" },
  });
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected, `expected ${name} tool`);
  return selected;
}

test("interpreter read tools deny /skills and traversal before backend access", async () => {
  const calls: string[] = [];
  const readFile = toolByName("read_file", calls);

  await assert.rejects(
    readFile.invoke({ file_path: "/skills/secret.md" }),
    (error) =>
      error instanceof InterpreterError && error.code === "PATH_DENIED",
  );
  await assert.rejects(
    readFile.invoke({ file_path: "/kb/../skills/secret.md" }),
    (error) =>
      error instanceof InterpreterError && error.code === "PATH_DENIED",
  );
  assert.deepEqual(calls, []);
});

test("interpreter read tools allow tenant-scoped knowledge and work files", async () => {
  const calls: string[] = [];
  const readFile = toolByName("read_file", calls);

  assert.equal(
    await readFile.invoke({ file_path: "/kb/source.md", limit: 20 }),
    "content:/kb/source.md",
  );
  assert.equal(
    await readFile.invoke({ file_path: "/workfiles/note.md" }),
    "content:/workfiles/note.md",
  );
  assert.deepEqual(calls, ["/kb/source.md", "/workfiles/note.md"]);
});

test("root ls never exposes the skills mount", async () => {
  const ls = toolByName("ls");
  const value = String(await ls.invoke({ path: "/" }));

  assert.match(value, /\/kb\//);
  assert.match(value, /\/workfiles\//);
  assert.doesNotMatch(value, /\/skills\//);
});

test("only the explicit read allowlist is bridged", () => {
  const configuredLimits = limits();
  const tools = createInterpreterReadTools({
    backend: backendWithCalls([]),
    allowedTools: ["read_file", "grep"],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-allowlist" },
  });

  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    ["read_file", "grep"],
  );
});

test(
  "execution gate enforces per-turn eval limit and process queue timeout",
  { timeout: 1_000 },
  async (t) => {
    const configuredLimits = limits({
      maxConcurrentEvals: 1,
      maxEvalsPerTurn: 1,
      evalQueueTimeoutMs: 10,
    });
    const gate = createInterpreterExecutionGate(configuredLimits);
    const release = await gate.acquireEval("turn-a");
    void pendingHostOperation(t)().finally(release);

    await assert.rejects(
      gate.acquireEval("turn-a"),
      (error) =>
        error instanceof InterpreterError && error.code === "EVAL_LIMIT",
    );
    await assert.rejects(
      gate.acquireEval("turn-b"),
      (error) => error instanceof InterpreterError && error.code === "BUSY",
    );
    release();
  },
);

test(
  "execution gate enforces per-turn PTC budget and timeout",
  { timeout: 1_000 },
  async (t) => {
    const configuredLimits = limits({
      maxPtcCallsPerEval: 1,
      maxPtcCallsPerTurn: 1,
      ptcCallTimeoutMs: 10,
    });
    const gate = createInterpreterExecutionGate(configuredLimits);

    await assert.rejects(
      gate.runPtc("turn-timeout", pendingHostOperation(t)),
      (error) =>
        error instanceof InterpreterError && error.code === "PTC_TIMEOUT",
    );
    await assert.rejects(
      gate.runPtc("turn-timeout", async () => "late"),
      (error) =>
        error instanceof InterpreterError && error.code === "PTC_LIMIT",
    );
  },
);

test(
  "PTC timeout includes time waiting for a concurrency slot",
  { timeout: 1_000 },
  async (t) => {
    const configuredLimits = limits({
      maxConcurrentPtcPerTurn: 1,
      maxPtcCallsPerEval: 2,
      maxPtcCallsPerTurn: 2,
      ptcCallTimeoutMs: 10,
    });
    const gate = createInterpreterExecutionGate(configuredLimits);
    const firstTimeout = assert.rejects(
      gate.runPtc("turn-queue-timeout", pendingHostOperation(t)),
      (error) =>
        error instanceof InterpreterError && error.code === "PTC_TIMEOUT",
    );
    const queuedTimeout = assert.rejects(
      gate.runPtc("turn-queue-timeout", async () => "must not run"),
      (error) =>
        error instanceof InterpreterError && error.code === "PTC_TIMEOUT",
    );

    await Promise.all([firstTimeout, queuedTimeout]);
  },
);

test("interpreter guard rejects oversized code and caps model-visible output", async () => {
  const configuredLimits = limits({ maxCodeChars: 5, maxResultChars: 32 });
  const middleware = createSourceWeftInterpreterMiddleware({
    backend: backendWithCalls([]),
    allowedTools: [],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-guard" },
  });
  const guard = middleware[1] as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  await assert.rejects(
    guard.wrapToolCall(
      { toolCall: { id: "eval-big", name: "eval", args: { code: "123456" } } },
      async () => assert.fail("oversized code must not execute"),
    ),
    (error) => error instanceof InterpreterError && error.code === "EVAL_LIMIT",
  );

  const result = await guard.wrapToolCall(
    { toolCall: { id: "eval-ok", name: "eval", args: { code: "1+1" } } },
    async () =>
      new ToolMessage({
        content: "x".repeat(100),
        tool_call_id: "eval-ok",
      }),
  );
  assert.ok(ToolMessage.isInstance(result));
  assert.ok(String(result.content).length <= configuredLimits.maxResultChars);
  assert.match(String(result.content), /truncated/);
});

test("interpreter guard maps runtime timeout output to a stable error", async () => {
  const configuredLimits = limits();
  const middleware = createSourceWeftInterpreterMiddleware({
    backend: backendWithCalls([]),
    allowedTools: [],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-runtime-error" },
  });
  const guard = middleware[1] as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const result = await guard.wrapToolCall(
    {
      toolCall: { id: "eval-timeout", name: "eval", args: { code: "loop()" } },
    },
    async () =>
      new ToolMessage({
        content: "InternalError: interrupted at guest source line 10",
        tool_call_id: "eval-timeout",
      }),
  );

  assert.ok(ToolMessage.isInstance(result));
  assert.equal(
    result.content,
    "[RUNTIME_TIMEOUT] Interpreter evaluation timed out.",
  );
});

test("interpreter guard preserves ordinary output containing timeout words", async () => {
  const configuredLimits = limits();
  const middleware = createSourceWeftInterpreterMiddleware({
    backend: backendWithCalls([]),
    allowedTools: [],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-ordinary-timeout-text" },
  });
  const guard = middleware[1] as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const result = await guard.wrapToolCall(
    {
      toolCall: {
        id: "eval-timeout-text",
        name: "eval",
        args: { code: "'timeout is a label'" },
      },
    },
    async () =>
      new ToolMessage({
        content: "→ timeout is a label",
        tool_call_id: "eval-timeout-text",
      }),
  );

  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.content, "→ timeout is a label");
});

test("official middleware exposes only allowlisted PTC functions and no task global", async () => {
  const configuredLimits = limits();
  const middleware = createSourceWeftInterpreterMiddleware({
    backend: backendWithCalls([]),
    allowedTools: ["read_file"],
    limits: configuredLimits,
    gate: createInterpreterExecutionGate(configuredLimits),
    context: { turnId: "turn-ptc-surface" },
  });
  const official = middleware[0] as unknown as {
    afterAgent?: (state: unknown, runtime: unknown) => unknown;
    tools: Array<{
      invoke: (input: unknown, config?: unknown) => Promise<unknown>;
    }>;
    wrapModelCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const runtime = { configurable: { thread_id: "thread-ptc-surface" } };
  await official.wrapModelCall(
    {
      tools: [],
      systemMessage: new SystemMessage(""),
    },
    async () => new AIMessage("ready"),
  );

  const output = String(
    await official.tools[0]?.invoke(
      {
        code: "[typeof tools.readFile, typeof tools.writeFile, typeof task]",
      },
      runtime,
    ),
  );
  assert.match(output, /"function"/);
  assert.match(output, /"undefined"[\s\S]*"undefined"/);
  await official.afterAgent?.({}, runtime);
});

test("QuickJS runtime has no host process, module loader, or network global", async () => {
  const session = new ReplSession("sandbox-globals", {
    memoryLimitBytes: DEFAULT_INTERPRETER_LIMITS.memoryLimitBytes,
    maxStackSizeBytes: DEFAULT_INTERPRETER_LIMITS.maxStackSizeBytes,
    maxResultChars: DEFAULT_INTERPRETER_LIMITS.maxResultChars,
  });
  try {
    const result = await session.eval(
      "[typeof process, typeof require, typeof fetch, typeof XMLHttpRequest]",
      1_000,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  } finally {
    session.dispose();
  }
});

test("QuickJS interrupts non-terminating code", async () => {
  const session = new ReplSession("sandbox-timeout", {
    memoryLimitBytes: DEFAULT_INTERPRETER_LIMITS.memoryLimitBytes,
    maxStackSizeBytes: DEFAULT_INTERPRETER_LIMITS.maxStackSizeBytes,
  });
  try {
    const result = await session.eval("while (true) {}", 25);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.error), /interrupt|timed out/i);
  } finally {
    session.dispose();
  }
});
