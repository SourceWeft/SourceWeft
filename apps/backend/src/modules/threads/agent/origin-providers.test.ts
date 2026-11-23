import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { SelectedSkillsBackend } from "../../skills/backend";
import { TurnSkillSandboxAssets } from "../../skills/sandbox-assets";
import { createPreparedThreadTurn } from "../../../test/prepared-turn";
import { applyUnattendedToolPolicy } from "./unattended-policy";
import type { FilesystemBackend, ToolCollection } from "./turn/turn-assembly";

type Named = { name: string; tools?: Named[] };
type AgentParams = {
  tools: Named[];
  interruptOn?: Record<string, unknown>;
  permissions?: unknown;
  unattended?: boolean;
  todoList?: boolean;
  chatBasePrompt?: boolean;
  extraMiddleware: Named[];
  runtimePrompt: string;
  subagents: Array<{
    name: string;
    tools?: Named[];
    interruptOn?: Record<string, unknown>;
    middleware: Named[];
  }>;
};

const created: AgentParams[] = [];

// The agent itself is not built: the test reads what it would be built with.
vi.mock("./index", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createThreadAgent: vi.fn(async (params: AgentParams) => {
    created.push(params);
    return {};
  }),
}));

const {
  buildRuntimePromptContext,
  buildThreadAgentAssembly,
  restrictToolCollectionForUnattendedRun,
} = await import("./turn/turn-assembly");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  created.length = 0;
});

const filesystemBackend = {
  backend: {} as BackendProtocolV2,
  knowledgeBackend: {} as never,
  workingFilesBackend: {} as never,
  filesystemMounts: [],
  skillsBackend: new SelectedSkillsBackend([]),
  skillSandboxAssets: new TurnSkillSandboxAssets(),
  citationRegistry: undefined,
} as unknown as FilesystemBackend;

const tool = (name: string) => ({ name }) as never;
const gate = { allowedDecisions: ["approve", "reject"] };

/** What an ordinary turn of a well-equipped workspace would be offered. */
function toolCollection(): ToolCollection {
  return {
    capabilityTools: [
      tool("search_sources"),
      tool("web_search"),
      tool("web_fetch"),
      tool("publish_artifact"),
    ],
    skillTools: [tool("search_skills"), tool("enable_skill")],
    webTools: [tool("web_search"), tool("web_fetch")],
    artifactTools: [tool("publish_artifact")],
    promptProviders: [],
    connectorActionTools: [
      tool("search_notion_pages"),
      tool("send_gmail_message"),
    ],
    connectorInterruptOn: { send_gmail_message: gate },
    mcpTools: [tool("mcp__docs__search"), tool("mcp__docs__delete_page")],
    connectorToolContext: {},
    mcpToolRuntime: {
      tools: [],
      interruptOn: { mcp__docs__delete_page: gate },
      close: async () => {},
    },
  } as unknown as ToolCollection;
}

const names = (items: ReadonlyArray<Named> | undefined) =>
  (items ?? []).map((item) => item.name).sort();

/** Everything about an assembled turn the origin hook could change. */
function shape(agent: AgentParams, runtimePrompt: string) {
  return {
    tools: names(agent.tools),
    interruptOn: Object.keys(agent.interruptOn ?? {}).sort(),
    hasInterruptOn: "interruptOn" in agent,
    permissions: agent.permissions,
    unattended: agent.unattended,
    extraMiddleware: agent.extraMiddleware.map((middleware) => ({
      name: middleware.name,
      tools: names(middleware.tools),
    })),
    subagents: agent.subagents.map((child) => ({
      name: child.name,
      tools: names(child.tools),
      interruptOn: Object.keys(child.interruptOn ?? {}).sort(),
      middleware: child.middleware.map((middleware) => ({
        name: middleware.name,
        tools: names(middleware.tools),
      })),
    })),
    // Booleans only, so unrelated prompt edits do not break the snapshot;
    // the same-run comparison below compares the whole prompt.
    scheduledRunBlock: runtimePrompt.includes("<scheduled_run>"),
    endsWithScheduledRunBlock: runtimePrompt
      .trimEnd()
      .endsWith("</scheduled_run>"),
  };
}

async function assembleTurn(input: {
  unattended: boolean;
  origin?: string;
  hostContext?: Record<string, string>;
  collection?: ToolCollection;
}) {
  const prepared = createPreparedThreadTurn({
    thread: { id: "thread_test", origin: input.origin ?? "user" },
    threadRunId: "thread_run_test",
    toolPermissions: input.unattended ? applyUnattendedToolPolicy({}) : {},
    ...(input.unattended ? { unattended: true } : {}),
    ...(input.hostContext ? { hostContext: input.hostContext } : {}),
  });
  const collection =
    input.collection ??
    (input.unattended
      ? restrictToolCollectionForUnattendedRun(toolCollection())
      : toolCollection());
  const { runtimePrompt } = await buildRuntimePromptContext({
    prepared,
    toolCollection: collection,
    sandboxRuntime: null,
  });
  await buildThreadAgentAssembly({
    prepared,
    toolCollection: collection,
    filesystemBackend,
    sandboxRuntime: null,
    runtimePrompt,
    model: {} as never,
  });
  return { agent: created.at(-1)!, runtimePrompt };
}

test("a turn with no origin provider is assembled exactly as before", async () => {
  for (const unattended of [false, true]) {
    const { agent, runtimePrompt } = await assembleTurn({ unattended });
    expect(shape(agent, runtimePrompt)).toMatchSnapshot(
      unattended ? "unattended" : "attended",
    );
  }
  assert.equal(created.length, 2);
});

// ---------------------------------------------------------------------------
// Per-origin turn providers
// ---------------------------------------------------------------------------

const { registerOriginTurnProvider, unregisterOriginTurnProvider } =
  await import("./origin-providers");
type OriginTurnContext = import("./origin-providers").OriginTurnContext;

const ROUTER_PROMPT = "<assistant_router>route the batch</assistant_router>";
const WORKER_PROMPT = "<assistant_ticket>work the ticket</assistant_ticket>";

function fakeProvider(input: {
  replaceTools: boolean;
  tools: string[];
  prompt: string;
  seen: OriginTurnContext[];
}) {
  return {
    replaceTools: input.replaceTools,
    tools: async (ctx: OriginTurnContext) => {
      input.seen.push(ctx);
      return input.tools.map(tool);
    },
    prompt: async (ctx: OriginTurnContext) => {
      input.seen.push(ctx);
      return input.prompt;
    },
  };
}

test("a replace-tools origin binds only its provider's tools, no sub-agents and no askUser, and its prompt closes the runtime prompt", async () => {
  const seen: OriginTurnContext[] = [];
  registerOriginTurnProvider(
    "assistant_router",
    fakeProvider({
      replaceTools: true,
      tools: ["say", "open_ticket"],
      prompt: ROUTER_PROMPT,
      seen,
    }),
  );
  try {
    const { agent, runtimePrompt } = await assembleTurn({
      unattended: true,
      origin: "assistant_router",
      hostContext: { batchId: "batch_1" },
    });
    assert.deepEqual(names(agent.tools), ["open_ticket", "say"]);
    assert.deepEqual(agent.subagents, []);
    // Deep Agents adds its own general-purpose delegate when the roster is
    // empty; the `task` tool is excluded so the model cannot reach it.
    const exclusion = agent.extraMiddleware.find(
      (middleware) => middleware.name === "SourceWeftOriginToolExclusion",
    );
    assert.ok(exclusion, "task tool exclusion middleware");
    assert.equal(agent.unattended, true);
    // No `write_todos`: the todo middleware is not mounted.
    assert.equal(agent.todoList, false);
    // Its system prompt is the runtime context alone, without the chat base.
    assert.equal(agent.chatBasePrompt, false);
    // Deep Agents always mounts its filesystem middleware, so it stays the
    // read-only one of an unattended run and its tools are excluded too.
    const filesystem = agent.extraMiddleware.find((middleware) =>
      names(middleware.tools).includes("read_file"),
    );
    assert.deepEqual(names(filesystem?.tools), [
      "glob",
      "grep",
      "ls",
      "read_file",
    ]);
    assert.ok(runtimePrompt.trimEnd().endsWith(ROUTER_PROMPT));
    // The provider prompt takes the place of the scheduled-run block.
    assert.equal(runtimePrompt.includes("<scheduled_run>"), false);
    // The prompt names no tool the turn does not have.
    for (const absent of ["web_search", "mcp__docs__search"]) {
      assert.equal(runtimePrompt.includes(absent), false, absent);
    }
    assert.equal(seen.length, 2);
    for (const ctx of seen) {
      assert.deepEqual(ctx, {
        workspaceId: "workspace_test",
        teamId: "team_test",
        threadId: "thread_test",
        runId: "thread_run_test",
        userId: "user_test",
        hostContext: { batchId: "batch_1" },
      });
    }
  } finally {
    unregisterOriginTurnProvider("assistant_router");
  }
});

test("an additive origin in an unattended run gets the unattended allow-list plus its provider's tools", async () => {
  const seen: OriginTurnContext[] = [];
  registerOriginTurnProvider(
    "assistant_ticket",
    fakeProvider({
      replaceTools: false,
      tools: ["report", "read_ticket"],
      prompt: WORKER_PROMPT,
      seen,
    }),
  );
  try {
    const { agent, runtimePrompt } = await assembleTurn({
      unattended: true,
      origin: "assistant_ticket",
    });
    const { agent: plain } = await assembleTurn({ unattended: true });
    assert.deepEqual(
      names(agent.tools),
      [...names(plain.tools), "read_ticket", "report"].sort(),
    );
    assert.ok(names(agent.tools).includes("report"));
    assert.equal(names(agent.tools).includes("publish_artifact"), false);
    assert.deepEqual(names(agent.subagents), [
      "explore",
      "general-purpose",
      "plan",
    ]);
    assert.equal(runtimePrompt.includes("<scheduled_run>"), false);
    assert.ok(runtimePrompt.trimEnd().endsWith(WORKER_PROMPT));
    assert.deepEqual(seen.at(-1)?.hostContext, {});
  } finally {
    unregisterOriginTurnProvider("assistant_ticket");
  }
});

test("a provider registered for another origin leaves an ordinary turn exactly as before", async () => {
  const { agent: before, runtimePrompt: beforePrompt } = await assembleTurn({
    unattended: true,
  });
  registerOriginTurnProvider(
    "assistant_router",
    fakeProvider({
      replaceTools: true,
      tools: ["say"],
      prompt: ROUTER_PROMPT,
      seen: [],
    }),
  );
  try {
    const { agent, runtimePrompt } = await assembleTurn({ unattended: true });
    assert.deepEqual(shape(agent, runtimePrompt), shape(before, beforePrompt));
    assert.equal(runtimePrompt, beforePrompt);
  } finally {
    unregisterOriginTurnProvider("assistant_router");
  }
});

test("a provider tool that collides with a bound tool fails the turn instead of shadowing it", async () => {
  registerOriginTurnProvider(
    "assistant_ticket",
    fakeProvider({
      replaceTools: false,
      tools: ["search_sources"],
      prompt: "",
      seen: [],
    }),
  );
  try {
    await assert.rejects(
      assembleTurn({ unattended: true, origin: "assistant_ticket" }),
      /search_sources/,
    );
  } finally {
    unregisterOriginTurnProvider("assistant_ticket");
  }
});

test("registering two providers for one origin is a wiring error", () => {
  const provider = fakeProvider({
    replaceTools: false,
    tools: [],
    prompt: "",
    seen: [],
  });
  registerOriginTurnProvider("assistant_ticket", provider);
  try {
    assert.throws(
      () => registerOriginTurnProvider("assistant_ticket", provider),
      /assistant_ticket/,
    );
  } finally {
    unregisterOriginTurnProvider("assistant_ticket");
  }
});

test("a scheduled turn keeps the scheduled-run block", async () => {
  const { runtimePrompt } = await assembleTurn({
    unattended: true,
    origin: "scheduled",
  });
  assert.ok(runtimePrompt.trimEnd().endsWith("</scheduled_run>"));
});

test("a host-owned conversation whose host is not wired fails the turn", async () => {
  for (const origin of ["assistant_router", "assistant_ticket"]) {
    await assert.rejects(
      assembleTurn({ unattended: true, origin }),
      new RegExp(`No origin turn provider is registered for '${origin}'`),
    );
  }
});

test("the origin tool exclusion hides `task` and the filesystem tools from the model and refuses a call to them", async () => {
  const { createOriginToolExclusionMiddleware } =
    await import("./origin-providers");
  const middleware = createOriginToolExclusionMiddleware() as unknown as {
    wrapModelCall: (
      request: { tools?: unknown[] },
      handler: (request: { tools?: unknown[] }) => unknown,
    ) => unknown;
    wrapToolCall: (
      request: { toolCall: { name: string; id?: string; args: unknown } },
      handler: (request: unknown) => unknown,
    ) => unknown;
  };

  const seenRequests: Array<{ tools?: unknown[] }> = [];
  await middleware.wrapModelCall(
    {
      tools: [
        { name: "say" },
        { name: "task" },
        { name: "read_file" },
        { name: "ls" },
        { name: "glob" },
        { name: "grep" },
        { name: "open_ticket" },
      ],
    },
    (request) => {
      seenRequests.push(request);
      return "model-result";
    },
  );
  assert.deepEqual(names(seenRequests[0]!.tools as Named[]), [
    "open_ticket",
    "say",
  ]);

  const handler = vi.fn(() => "tool-result");
  const refused = (await middleware.wrapToolCall(
    { toolCall: { name: "task", id: "call_1", args: {} } },
    handler,
  )) as { status?: string; tool_call_id?: string; name?: string };
  assert.equal(handler.mock.calls.length, 0);
  assert.equal(refused.status, "error");
  assert.equal(refused.tool_call_id, "call_1");
  assert.equal(refused.name, "task");

  const refusedRead = (await middleware.wrapToolCall(
    { toolCall: { name: "read_file", id: "call_3", args: {} } },
    handler,
  )) as { status?: string; name?: string };
  assert.equal(handler.mock.calls.length, 0);
  assert.equal(refusedRead.status, "error");
  assert.equal(refusedRead.name, "read_file");

  const passed = await middleware.wrapToolCall(
    { toolCall: { name: "say", id: "call_2", args: {} } },
    handler,
  );
  assert.equal(passed, "tool-result");
  assert.equal(handler.mock.calls.length, 1);
});
