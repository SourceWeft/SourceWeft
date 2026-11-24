import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentToolGroundedArtifactServices } from "@sourceweft/contracts/agent-tools";
import { TABLE_LIMITS } from "@sourceweft/contracts/table";
import {
  createCapabilityAgentTools,
  GENERATE_TABLE_TOOL_NAME,
  generateTableAgentTool,
  tableAgentToolDefs,
} from "../src/index";

type Call = Parameters<AgentToolGroundedArtifactServices["requestGeneration"]>[0];

function groundedArtifacts(
  sourceIds: readonly string[] = ["s1", "s2"],
  receipt: { reused: boolean; status: "pending" | "running" | "ready" } = {
    reused: false,
    status: "pending",
  },
) {
  const calls: Call[] = [];
  let listed = 0;
  const service: AgentToolGroundedArtifactServices = {
    listTurnSourceIds: async () => {
      listed += 1;
      return sourceIds;
    },
    requestGeneration: async (input) => {
      calls.push(input);
      return { artifactId: "artifact-1", versionNo: 1, ...receipt };
    },
  };
  return { service, calls, listed: () => listed };
}

/** A gateway that fails the test if the tool ever reaches for a model. */
const forbiddenModelGateway = {
  getClient: async () => {
    throw new Error("generate_table must never call a model");
  },
};

const context = {
  threadId: "thread-1",
  isToolDenied: () => false,
  shouldBindAgentTool: (name: string) => name === "generate_table",
};

function bind(service?: AgentToolGroundedArtifactServices, toolIds?: string[]) {
  const result = createCapabilityAgentTools({
    ...(toolIds ? { toolIds } : {}),
    context,
    services: {
      ...(service ? { groundedArtifacts: service } : {}),
      modelGateway: forbiddenModelGateway,
    } as never,
  });
  return result.tools.map((entry) => entry.tool);
}

const COLUMNS = [
  { name: "Price", description: "List price per seat", type: "number" as const },
  { name: "Launch date", type: "date" as const },
];

test("the definition is an artifact tool that a /table command may drive", () => {
  assert.equal(GENERATE_TABLE_TOOL_NAME, "generate_table");
  assert.deepEqual(tableAgentToolDefs, [generateTableAgentTool]);
  assert.equal(generateTableAgentTool.domain, "artifact");
  assert.equal(generateTableAgentTool.defaultPermission, "allow");
  assert.equal(generateTableAgentTool.riskLevel, "low");
  assert.equal(generateTableAgentTool.slash?.supportsCommand, true);
  assert.deepEqual(generateTableAgentTool.slash?.aliases, ["table"]);
});

test("generate_table starts a job through the host service and returns the receipt", async () => {
  const grounded = groundedArtifacts();
  const [tool] = bind(grounded.service);
  assert.equal(tool?.name, "generate_table");

  const result = (await tool!.invoke({
    columns: COLUMNS,
    instruction: "Compare pricing",
    userLanguage: "zh-CN",
  })) as Record<string, unknown>;

  assert.deepEqual(grounded.calls, [
    {
      artifactType: "table",
      request: {
        sourceIds: ["s1", "s2"],
        columns: COLUMNS,
        instruction: "Compare pricing",
      },
      uiLocale: "zh-CN",
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");
  assert.equal(result.artifactType, "table");
  assert.equal(result.artifactId, "artifact-1");
  assert.equal(result.versionNo, 1);
  assert.equal(result.reused, false);
  assert.equal(result.sources, 2);
  assert.equal(result.columns, 2);
  // It tells the agent where the table will appear and not to make up values.
  assert.match(String(result.nextStep), /Artifacts tab/);
  assert.match(String(result.nextStep), /do not/i);
});

test("an explicit output language is passed as the request's language", async () => {
  const grounded = groundedArtifacts();
  const [tool] = bind(grounded.service);
  await tool!.invoke({ columns: COLUMNS, language: "en", userLanguage: "zh-CN" });
  assert.equal(grounded.calls[0]!.request.language, "en");
  assert.equal(grounded.calls[0]!.uiLocale, "zh-CN");
});

test("generate_table never fills cells: the receipt carries no rows or values", async () => {
  const grounded = groundedArtifacts();
  const [tool] = bind(grounded.service);
  const result = (await tool!.invoke({
    columns: COLUMNS,
    userLanguage: "en",
  })) as Record<string, unknown>;
  assert.equal(result.rows, undefined);
  assert.equal(result.cells, undefined);
  assert.doesNotMatch(JSON.stringify(result), /"value"/);
  const source = readFileSync(new URL("../src/agent-tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fillTable|modelGateway|createTableCapability|\.\/engine/);
});

test("no tool binds without the grounded-artifact service, context or selection", () => {
  // The turn did not select it (no /table command, no skill).
  assert.deepEqual(
    createCapabilityAgentTools({
      context: { ...context, shouldBindAgentTool: () => false },
      services: { groundedArtifacts: groundedArtifacts().service },
    }).tools,
    [],
  );
  assert.deepEqual(bind(undefined), []);
  assert.deepEqual(bind(groundedArtifacts().service, ["web_search"]), []);
  assert.deepEqual(
    createCapabilityAgentTools({ services: { groundedArtifacts: groundedArtifacts().service } })
      .tools,
    [],
  );
  assert.deepEqual(
    createCapabilityAgentTools({
      context: { ...context, isToolDenied: (name: string) => name === "generate_table" },
      services: { groundedArtifacts: groundedArtifacts().service },
    }).tools,
    [],
  );
});

async function rejected(args: Record<string, unknown>, sourceIds?: string[]) {
  const grounded = groundedArtifacts(sourceIds);
  const [tool] = bind(grounded.service);
  // Deliberately invalid input, so the typed schema is bypassed here.
  await assert.rejects(tool!.invoke(args as never));
  assert.equal(grounded.calls.length, 0, "nothing was requested");
}

test("more than 12 columns are rejected before anything is requested", async () => {
  await rejected({
    columns: Array.from({ length: TABLE_LIMITS.maxColumns + 1 }, (_, index) => ({
      name: `Column ${index}`,
      type: "text",
    })),
    userLanguage: "en",
  });
});

test("an empty column name, no columns or no user language are rejected", async () => {
  await rejected({ columns: [{ name: "   ", type: "text" }], userLanguage: "en" });
  await rejected({ columns: [], userLanguage: "en" });
  await rejected({ columns: COLUMNS });
  await rejected({ columns: [{ name: "Price", type: "currency" }], userLanguage: "en" });
});

test("a table over the cell limit is rejected by the table contract", async () => {
  const sourceIds = Array.from({ length: TABLE_LIMITS.maxSources }, (_, index) => `s${index}`);
  await rejected(
    {
      columns: Array.from({ length: TABLE_LIMITS.maxColumns }, (_, index) => ({
        name: `Column ${index}`,
        type: "text",
      })),
      userLanguage: "en",
    },
    sourceIds,
  );
});

test("with no sources in the turn the tool asks for them and requests nothing", async () => {
  const grounded = groundedArtifacts([]);
  const [tool] = bind(grounded.service);
  const result = (await tool!.invoke({
    columns: COLUMNS,
    userLanguage: "en",
  })) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_SOURCES");
  assert.match(String(result.message), /select or @mention/i);
  assert.equal(grounded.listed(), 1);
  assert.deepEqual(grounded.calls, []);
});

test("more sources than one table can compare: the tool says so with the limit and requests nothing", async () => {
  const sourceIds = Array.from({ length: TABLE_LIMITS.maxSources + 1 }, (_, index) => `s${index}`);
  const grounded = groundedArtifacts(sourceIds);
  const [tool] = bind(grounded.service);
  const result = (await tool!.invoke({ columns: COLUMNS, userLanguage: "en" })) as Record<
    string,
    unknown
  >;
  assert.equal(result.ok, false);
  assert.equal(result.code, "TOO_MANY_SOURCES");
  assert.equal(result.sources, TABLE_LIMITS.maxSources + 1);
  assert.equal(result.maxSources, TABLE_LIMITS.maxSources);
  assert.match(String(result.message), new RegExp(`${TABLE_LIMITS.maxSources} or fewer`));
  assert.match(String(result.message), /narrow the selection/);
  assert.deepEqual(grounded.calls, []);
});

test("a repeat of a table that is already ready says so instead of promising it", async () => {
  const grounded = groundedArtifacts(["s1", "s2"], { reused: true, status: "ready" });
  const [tool] = bind(grounded.service);
  const result = (await tool!.invoke({ columns: COLUMNS, userLanguage: "en" })) as Record<
    string,
    unknown
  >;
  assert.equal(result.status, "ready");
  assert.match(String(result.nextStep), /already ready/);
  assert.doesNotMatch(String(result.nextStep), /when it is ready|being generated/);
});

test("the /table workflow tells the agent to narrow too many sources", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../sourceweft.capability.json", import.meta.url), "utf8"),
  ) as { tools: { command: { workflow: { additionalPromptLines: string[] } } }[] };
  const prompt = manifest.tools[0]!.command.workflow.additionalPromptLines.join("\n");
  assert.match(prompt, /too many sources/);
  assert.match(prompt, /narrow the selection/);
});
