import assert from "node:assert/strict";
import type { BackendProtocolV2 } from "deepagents";
import { beforeEach, test, vi } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { SelectedSkillsBackend } from "../../../skills/backend";
import { TurnSkillSandboxAssets } from "../../../skills/sandbox-assets";
import { createPreparedThreadTurn } from "../../../../test/prepared-turn";
import {
  UNATTENDED_FILESYSTEM_PERMISSIONS,
  applyUnattendedToolPolicy,
} from "../unattended-policy";
import type { FilesystemBackend, ToolCollection } from "./turn-assembly";

type AgentParams = {
  tools: Array<{ name: string }>;
  interruptOn?: Record<string, unknown>;
  permissions?: unknown;
  unattended?: boolean;
  extraMiddleware: Array<{ name: string }>;
  runtimePrompt: string;
  subagents: Array<{
    name: string;
    tools?: Array<{ name: string }>;
    interruptOn?: Record<string, unknown>;
    middleware: Array<{ name: string; tools?: Array<{ name: string }> }>;
  }>;
};

const created: AgentParams[] = [];

// The agent itself is not built: the test reads what it would be built with.
vi.mock("..", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createThreadAgent: vi.fn(async (params: AgentParams) => {
    created.push(params);
    return {};
  }),
}));

const {
  buildRuntimePromptContext,
  buildSandboxRuntimeForPreparedTurn,
  buildThreadAgentAssembly,
  restrictToolCollectionForUnattendedRun,
} = await import("./turn-assembly");

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
      tool("generate_image"),
    ],
    skillTools: [
      tool("search_skills"),
      tool("install_skill"),
      tool("enable_skill"),
    ],
    webTools: [tool("web_search"), tool("web_fetch")],
    artifactTools: [tool("publish_artifact")],
    promptProviders: [],
    connectorActionTools: [
      tool("search_notion_pages"),
      tool("create_notion_page"),
      tool("send_gmail_message"),
    ],
    connectorInterruptOn: {
      create_notion_page: gate,
      send_gmail_message: gate,
    },
    mcpTools: [tool("mcp__docs__search"), tool("mcp__docs__delete_page")],
    connectorToolContext: {},
    mcpToolRuntime: {
      tools: [],
      interruptOn: { mcp__docs__delete_page: gate },
      close: async () => {},
    },
  } as unknown as ToolCollection;
}

async function assemble(unattended: boolean) {
  const prepared = createPreparedThreadTurn({
    toolPermissions: unattended ? applyUnattendedToolPolicy({}) : {},
    ...(unattended ? { unattended: true } : {}),
  });
  await buildThreadAgentAssembly({
    prepared,
    toolCollection: toolCollection(),
    filesystemBackend,
    sandboxRuntime: null,
    runtimePrompt: "runtime",
    model: {} as never,
  });
  return created.at(-1)!;
}

const names = (items: ReadonlyArray<{ name: string }> | undefined) =>
  (items ?? []).map((item) => item.name).sort();

test("an attended turn is offered write tools, connector actions and gated MCP tools, behind approvals", async () => {
  const agent = await assemble(false);
  const tools = names(agent.tools);
  for (const name of [
    "publish_artifact",
    "generate_image",
    "search_skills",
    "create_notion_page",
    "send_gmail_message",
    "mcp__docs__delete_page",
  ]) {
    assert.ok(tools.includes(name), name);
  }
  assert.deepEqual(Object.keys(agent.interruptOn ?? {}).sort(), [
    "create_notion_page",
    "enable_skill",
    "mcp__docs__delete_page",
    "send_gmail_message",
  ]);
  assert.notEqual(agent.unattended, true);
});

test("an unattended turn binds read-class tools only and has no approval path at all", async () => {
  const agent = await assemble(true);
  assert.deepEqual(names(agent.tools), [
    "mcp__docs__search",
    "read_document",
    "search_files",
    "search_sources",
    "view_image",
    "web_fetch",
    "web_search",
  ]);
  // Nothing is gated, so nothing can be approved: by a person, by a trust
  // rule, or by anything else.
  assert.equal("interruptOn" in agent, false);
  assert.equal(agent.unattended, true);
  assert.deepEqual(agent.permissions, UNATTENDED_FILESYSTEM_PERMISSIONS);

  // The root's filesystem tools are the read tools; no code interpreter.
  const filesystem = agent.extraMiddleware.find(
    (middleware) =>
      "tools" in middleware &&
      names((middleware as { tools?: Array<{ name: string }> }).tools).includes(
        "read_file",
      ),
  ) as { tools?: Array<{ name: string }> } | undefined;
  assert.deepEqual(names(filesystem?.tools), [
    "glob",
    "grep",
    "ls",
    "read_file",
  ]);
  assert.equal(
    agent.extraMiddleware.some((middleware) =>
      /interpreter/i.test(middleware.name),
    ),
    false,
  );
});

test("the sub-agents of an unattended turn get no more than the turn itself", async () => {
  const agent = await assemble(true);
  const allowed = new Set(names(agent.tools));
  assert.deepEqual(names(agent.subagents), [
    "explore",
    "general-purpose",
    "plan",
  ]);
  for (const child of agent.subagents) {
    for (const name of names(child.tools))
      assert.ok(allowed.has(name), `${child.name}: ${name}`);
    const middlewareNames = child.middleware.map(
      (middleware) => middleware.name,
    );
    assert.equal(
      middlewareNames.includes("SourceWeftAskUser"),
      false,
      child.name,
    );
    assert.equal(
      middlewareNames.some((name) => /humanInTheLoop/i.test(name)),
      false,
      child.name,
    );
    // Every child's own filesystem tools are the read tools.
    const fileTools = child.middleware.flatMap((middleware) =>
      names(middleware.tools),
    );
    for (const name of ["write_file", "edit_file", "execute"]) {
      assert.equal(fileTools.includes(name), false, `${child.name}: ${name}`);
    }
    assert.ok(fileTools.includes("read_file"), child.name);
  }
  const general = agent.subagents.find(
    (child) => child.name === "general-purpose",
  )!;
  assert.deepEqual(general.interruptOn ?? {}, {});
});

test("an unattended turn never gets a sandbox, whatever its permissions say", async () => {
  const prepared = createPreparedThreadTurn({
    unattended: true,
    toolPermissions: { [AGENT_TOOL_NAMES.execute]: "allow" },
    runtimeTools: {
      [AGENT_TOOL_NAMES.execute]: {
        toolName: AGENT_TOOL_NAMES.execute,
        enabled: true,
        permission: "allow",
        shouldBind: true,
        selection: {},
        options: {},
      },
    },
  });
  assert.equal(
    await buildSandboxRuntimeForPreparedTurn({ prepared, filesystemBackend }),
    null,
  );
});

test("the runtime prompt of an unattended turn ends with the scheduled-run block and names no tool it lacks", async () => {
  const collection = toolCollection();
  const attended = await buildRuntimePromptContext({
    prepared: createPreparedThreadTurn(),
    toolCollection: collection,
    sandboxRuntime: null,
  });
  assert.equal(attended.runtimePrompt.includes("<scheduled_run>"), false);

  assert.ok(attended.runtimePrompt.includes("publish_artifact"));
  assert.ok(attended.runtimePrompt.includes("mcp__docs__delete_page"));

  const restricted = restrictToolCollectionForUnattendedRun(collection);
  assert.deepEqual(
    {
      capability: names(restricted.capabilityTools),
      skill: names(restricted.skillTools),
      web: names(restricted.webTools),
      artifact: names(restricted.artifactTools),
      connector: names(restricted.connectorActionTools),
      mcp: names(restricted.mcpTools),
      gates: Object.keys(restricted.connectorInterruptOn),
    },
    {
      capability: ["search_sources", "web_fetch", "web_search"],
      skill: [],
      web: ["web_fetch", "web_search"],
      artifact: [],
      connector: [],
      mcp: ["mcp__docs__search"],
      gates: [],
    },
  );
  const unattended = await buildRuntimePromptContext({
    prepared: createPreparedThreadTurn({ unattended: true }),
    toolCollection: restricted,
    sandboxRuntime: null,
  });
  assert.ok(unattended.runtimePrompt.trimEnd().endsWith("</scheduled_run>"));
  assert.ok(unattended.runtimePrompt.includes("mcp__docs__search"));
  assert.equal(unattended.runtimePrompt.includes("publish_artifact"), false);
  assert.equal(
    unattended.runtimePrompt.includes("mcp__docs__delete_page"),
    false,
  );
});
