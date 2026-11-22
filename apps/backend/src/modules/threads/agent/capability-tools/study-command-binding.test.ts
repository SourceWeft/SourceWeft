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
 * `/flashcards`, `/quiz` and `/mindmap` turns through the real command
 * resolution, tool selection, capability discovery (the study package reached
 * through the registry), factories and host binder. Only what would leave the
 * process is stubbed: the study request's database work, the source lookup,
 * the web provider and model calls.
 *
 * Billing: what this file proves is the turn's side only. With the study
 * request function mocked, calling a bound study tool reads nothing of the
 * turn's billing port, makes no model call through the turn, and hands the
 * request to the study request function as the turn's actor. That the queued
 * job then bills that actor on its own scope is `study/job-billing.test.ts`.
 */

const hostMocks = vi.hoisted(() => ({
  webProvider: vi.fn<() => Promise<AgentToolWebProvider | null>>(async () => null),
  getClient: vi.fn(async () => {
    throw new Error("A study tool must not execute a model request");
  }),
  requestStudyArtifact: vi.fn(),
  listSourceRecordsByIds: vi.fn(),
}));

vi.mock("../../../sources/web-provider", () => ({
  createDefaultWebProvider: hostMocks.webProvider,
}));
vi.mock("../../../study/requests", () => ({
  requestStudyArtifact: hostMocks.requestStudyArtifact,
}));
vi.mock("../../../sources/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sources/repository")>()),
  listSourceRecordsByIds: hostMocks.listSourceRecordsByIds,
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

const STUDY_COMMANDS = [
  { command: "flashcards", tool: "generate_flashcards", artifactType: "flashcards" },
  { command: "quiz", tool: "generate_quiz", artifactType: "quiz" },
  { command: "mindmap", tool: "generate_mindmap", artifactType: "mindmap" },
] as const;

async function prepareCommandTurn(
  name: string,
  args: string,
  sourceIds: readonly string[] = ["source-1", "source-2"],
) {
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
    runTraceId: "turn-trace-1",
    sourceIds: [...sourceIds],
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

/**
 * The turn's billing port, recording every member read. A tool that charged
 * the turn (or opened a billed model call through it) would have to read it.
 */
function recordingBilling() {
  const reads: string[] = [];
  const port = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "string" && property !== "then") reads.push(property);
        return undefined;
      },
    },
  );
  return { port, reads };
}

function bind(
  prepared: CapabilityAgentToolsForTurnInput["prepared"],
  billing: unknown = {},
) {
  return createCapabilityAgentToolsForTurn({
    prepared,
    billing: billing as never,
    runtime: { citationRegistry: new AgentCitationRegistry() } as never,
    filesystemBackend: { backend: {} } as never,
    sandboxRuntime: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.webProvider.mockResolvedValue(null);
  hostMocks.requestStudyArtifact.mockResolvedValue({
    artifactId: "artifact-1",
    versionNo: 1,
    status: "pending",
    artifactStatus: "pending",
    visibility: "private",
    reused: false,
  });
  hostMocks.listSourceRecordsByIds.mockImplementation(
    async (input: { sourceIds: string[] }) =>
      input.sourceIds.map((id) => ({ id, sourceType: "file" })),
  );
});

for (const study of STUDY_COMMANDS) {
  test(`a /${study.command} turn binds ${study.tool} and nothing else, without a binding error`, async () => {
    const prepared = await prepareCommandTurn(study.command, "");
    const bound = await bind(prepared);
    assert.deepEqual(
      bound.tools.map((tool) => tool.name),
      [study.tool],
    );
    assert.deepEqual(
      bound.artifactTools.map((tool) => tool.name),
      [study.tool],
    );
    assert.equal(hostMocks.getClient.mock.calls.length, 0);
  });
}

test("an ordinary turn binds no study tool", async () => {
  const prepared = await prepareCommandTurn("quiz", "");
  const plain = {
    ...prepared,
    command: null,
    commandSuccessCriteria: { kind: "none" },
    effectiveTools: {},
    runtimeTools: {},
    toolPermissions: resolveToolPermissions({ command: null, tools: {} }),
  } as unknown as CapabilityAgentToolsForTurnInput["prepared"];
  const names = (await bind(plain)).tools.map((tool) => tool.name);
  for (const study of STUDY_COMMANDS) assert.ok(!names.includes(study.tool));
});

test("a /quiz tool call queues the request as the turn's actor, in the turn's thread", async () => {
  const prepared = await prepareCommandTurn("quiz", "10 hard questions on chapter 2");
  const [tool] = (await bind(prepared)).tools;
  const result = (await tool!.invoke({
    count: 10,
    difficulty: "hard",
    focus: "chapter 2",
    userLanguage: "en",
  })) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.artifactId, "artifact-1");
  assert.equal(result.status, "pending");
  assert.equal(hostMocks.requestStudyArtifact.mock.calls.length, 1);
  assert.deepEqual(hostMocks.requestStudyArtifact.mock.calls[0]![0], {
    workspaceId: "workspace-1",
    userId: "user-1",
    uiLocale: "en",
    request: {
      threadId: "thread-1",
      artifactType: "quiz",
      sourceIds: ["source-1", "source-2"],
      options: { count: 10, difficulty: "hard", focus: "chapter 2" },
    },
  });
});

test("a study tool call reads nothing of the turn's billing port, calls no model, and requests as the turn's actor", async () => {
  for (const study of STUDY_COMMANDS) {
    const billing = recordingBilling();
    const prepared = await prepareCommandTurn(study.command, "");
    const [tool] = (await bind(prepared, billing.port)).tools;
    // Binding may hand the port to services that keep it; the call must not use it.
    billing.reads.length = 0;

    const result = (await tool!.invoke({ userLanguage: "en" })) as Record<string, unknown>;

    assert.equal(result.ok, true);
    assert.deepEqual(billing.reads, [], `${study.tool} charged nothing to the chat turn`);
    assert.equal(hostMocks.getClient.mock.calls.length, 0, "no model call in the turn");
    // The request (mocked here) is made as the person who asked.
    const call = hostMocks.requestStudyArtifact.mock.calls.at(-1)![0];
    assert.equal(call.userId, "user-1");
    assert.equal(call.request.artifactType, study.artifactType);
  }
});

test("with no sources selected the tool asks for them and queues nothing", async () => {
  for (const study of STUDY_COMMANDS) {
    const prepared = await prepareCommandTurn(study.command, "", []);
    const [tool] = (await bind(prepared)).tools;
    const result = (await tool!.invoke({ userLanguage: "en" })) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_SOURCES");
    assert.match(String(result.message), /select or @mention/);
  }
  assert.equal(hostMocks.requestStudyArtifact.mock.calls.length, 0);
});

test("a selection of folders only counts as no sources", async () => {
  hostMocks.listSourceRecordsByIds.mockImplementation(
    async (input: { sourceIds: string[] }) =>
      input.sourceIds.map((id) => ({ id, sourceType: "directory" })),
  );
  const prepared = await prepareCommandTurn("flashcards", "", ["dir-1"]);
  const [tool] = (await bind(prepared)).tools;
  const result = (await tool!.invoke({ userLanguage: "en" })) as Record<string, unknown>;
  assert.equal(result.code, "NO_SOURCES");
  assert.equal(hostMocks.requestStudyArtifact.mock.calls.length, 0);
});
