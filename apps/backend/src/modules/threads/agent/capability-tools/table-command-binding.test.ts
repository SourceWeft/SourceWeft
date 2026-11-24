import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import {
  buildEffectiveToolsSelection,
  buildRuntimeTools,
} from "../../turn/tool-selection";
import {
  mergeCommandTools,
  resolveToolPermissions,
} from "../../turn/thread-command-tools";
import { resolveThreadCommand } from "../../turn/thread-command";
import type { CapabilityAgentToolsForTurnInput } from "./types";
import { AgentCitationRegistry } from "../citation-registry";

/**
 * A `/table` turn through the real command resolution, tool selection,
 * capability discovery, factories and host binder. Only external execution
 * (the web provider, model calls) is stubbed: binding must not need either.
 *
 * Regression: the retrieval factory bound `search_sources` on every turn it
 * was not denied, ignoring the turn's binding decision. A tool command turn
 * binds only the tools its workflow names, so the host rejected the extra
 * binding (CAPABILITY_TOOL_BINDING_UNEXPECTED) and the chat run failed.
 */

const hostMocks = vi.hoisted(() => ({
  webProvider: vi.fn<() => Promise<AgentToolWebProvider | null>>(async () => null),
  getClient: vi.fn(async () => {
    throw new Error("Binding must not execute a model request");
  }),
}));

vi.mock("../../../sources/web-provider", () => ({
  createDefaultWebProvider: hostMocks.webProvider,
}));
vi.mock("./host-services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-services")>();
  return {
    ...actual,
    createCapabilityAgentToolHostServices: (
      ...args: Parameters<typeof actual.createCapabilityAgentToolHostServices>
    ) => {
      const services = actual.createCapabilityAgentToolHostServices(...args);
      return {
        ...services,
        modelGateway: { ...services.modelGateway, getClient: hostMocks.getClient },
      };
    },
  };
});

const { createCapabilityAgentToolsForTurn } = await import("./index");

async function prepareCommandTurn(name: string, args: string) {
  const command = await resolveThreadCommand({
    command: { name, arguments: args, kind: "tool" },
    enabledSkills: [],
  });
  assert.ok(command?.workflow, `${name} resolves to a workflow command`);
  const effectiveTools = buildEffectiveToolsSelection({
    baseTools: mergeCommandTools({}, command),
    skillIds: [],
    webAccessEnabled: false,
  });
  const toolPermissions = resolveToolPermissions({ command, tools: effectiveTools });
  return {
    workspace: { id: "workspace-1", organizationId: "team-1" },
    thread: { id: "thread-1" },
    userId: "user-1",
    userMessage: { id: "message-1", metadata: null },
    sourceIds: ["source-1", "source-2", "source-3"],
    effectiveMentionedSourceIds: [],
    effectiveTools,
    enabledSkills: [],
    invokedSkillIds: [],
    command,
    invocation: null,
    commandSuccessCriteria: command.workflow.successCriteria,
    toolPermissions,
    runtimeTools: buildRuntimeTools({ tools: effectiveTools, toolPermissions }),
    turnState: {},
    threadRunId: "run-1",
    webAccessEnabled: false,
  } as unknown as CapabilityAgentToolsForTurnInput["prepared"];
}

function bind(prepared: CapabilityAgentToolsForTurnInput["prepared"]) {
  return createCapabilityAgentToolsForTurn({
    prepared,
    billing: {} as never,
    runtime: { citationRegistry: new AgentCitationRegistry() } as never,
    filesystemBackend: { backend: {} } as never,
    sandboxRuntime: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.webProvider.mockResolvedValue(null);
});

test("a /table turn binds generate_table and source search without a binding error", async () => {
  const prepared = await prepareCommandTurn(
    "table",
    "Compare these three vector databases on free tier limits, cheapest paid plan, and uptime SLA.",
  );
  const bound = await bind(prepared);
  const names = bound.tools.map((tool) => tool.name).sort();
  assert.ok(names.includes("generate_table"), "the command's tool is bound");
  // The workflow names source search, so the agent can read the sources
  // before proposing columns.
  assert.ok(names.includes("search_sources"), "source search stays available");
  assert.deepEqual(
    bound.artifactTools.map((tool) => tool.name),
    ["generate_table"],
  );
  assert.deepEqual(
    bound.retrievalTools.map((tool) => tool.name),
    ["search_sources"],
  );
  assert.equal(hostMocks.getClient.mock.calls.length, 0);
});

test("a tool command turn binds only the tools its workflow names", async () => {
  const prepared = await prepareCommandTurn("table", "compare pricing");
  const names = (await bind(prepared)).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["generate_table", "search_sources"]);
});

test("an ordinary turn still binds source search and not generate_table", async () => {
  const prepared = await prepareCommandTurn("table", "compare pricing");
  const plain = {
    ...prepared,
    command: null,
    commandSuccessCriteria: { kind: "none" },
    effectiveTools: {},
    runtimeTools: {},
    toolPermissions: resolveToolPermissions({ command: null, tools: {} }),
  } as unknown as CapabilityAgentToolsForTurnInput["prepared"];
  const names = (await bind(plain)).tools.map((tool) => tool.name);
  assert.ok(names.includes("search_sources"));
  assert.ok(!names.includes("generate_table"));
});
