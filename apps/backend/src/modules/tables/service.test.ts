import assert from "node:assert/strict";
import {
  GroundedGenerationError,
  type GroundedAnchorPort,
} from "@sourceweft/contracts/grounded-generation";
import type {
  TableGenerationMembers,
  TableModelPort,
  TableSourceInput,
} from "@sourceweft/contracts/table-capability";
import { expect, test, vi } from "vitest";
import type { GuidePayerPorts } from "../sources/guide-payer";
import { loadTableGeneration } from "./capability";
import { pickSourceSummary } from "./summaries";
import {
  runTableGeneration,
  suggestTableColumns,
  type TableGenerationRequest,
} from "./service";
import { tableContentFixture } from "./test-support";

type FillInput = Parameters<TableGenerationMembers["fillTable"]>[1];

const payerPorts: GuidePayerPorts = {
  resolveAccess: async () => ({}) as never,
  resolveResponsibleUserId: async () => "owner",
  resolveBillingOrganizationId: async () => "billing-org",
};
const payer = { userId: "user-1", billingOrganizationId: "billing-org" };

const model = (): TableModelPort & { calls: number } => {
  const port = {
    calls: 0,
    async completeStructured() {
      port.calls += 1;
      return {};
    },
  };
  return port;
};

/* ------------------------------------------------------------ suggestions */

const suggestRequest = {
  teamId: "team-1",
  workspaceId: "ws-1",
  userId: "user-1",
  sourceIds: ["src-1", "src-2"],
  instruction: "compare designs",
  uiLocale: "zh-CN",
};
const columns = [{ name: "Design", type: "text" as const }];

function fakeGeneration(overrides: Partial<TableGenerationMembers> = {}) {
  return {
    suggestColumns: vi.fn(async () => columns),
    resolveColumns: vi.fn(),
    planFill: vi.fn(),
    fillTable: vi.fn(),
    limits: { maxTotalInputTokens: 300_000, jobTimeoutMs: 60_000 },
    ...overrides,
  } as unknown as TableGenerationMembers;
}

test("the requester pays: the suggestion bills them, scoped to a per-request id, in the API scope", async () => {
  const generation = fakeGeneration();
  const createModelPort = vi.fn(() => model());
  const loadSummaries = vi.fn(async () => [
    { sourceId: "src-1", title: "Alpha", summary: "Alpha is a trial." },
    { sourceId: "src-2", title: "Beta", summary: "Beta is a cohort." },
  ]);
  const result = await suggestTableColumns(suggestRequest, {
    billing: {} as never,
    generation,
    payerPorts,
    describeModel: async () => ({ modelAlias: "m" }),
    loadSummaries,
    createModelPort,
  });
  assert.deepEqual(result, columns);
  expect(createModelPort).toHaveBeenCalledTimes(1);
  const [{ payer: usedPayer, scopeId }] = createModelPort.mock.calls[0] as unknown as [
    { payer: typeof payer; scopeId: string },
  ];
  assert.deepEqual(usedPayer, payer);
  assert.ok(scopeId.length > 8);
  expect(loadSummaries).toHaveBeenCalledWith({
    teamId: "team-1",
    workspaceId: "ws-1",
    sourceIds: ["src-1", "src-2"],
  });
  const [deps, input] = (generation.suggestColumns as ReturnType<typeof vi.fn>).mock
    .calls[0] as [{ model: unknown }, Record<string, unknown>];
  assert.ok(deps.model);
  assert.deepEqual(input.sources, [
    { title: "Alpha", summary: "Alpha is a trial." },
    { title: "Beta", summary: "Beta is a cohort." },
  ]);
  assert.equal(input.instruction, "compare designs");
  // No language requested: the answer follows the requester's UI.
  assert.equal(input.language, "zh-CN");
  assert.match(String(input.referenceId), /^table-suggest:/);
  assert.ok(String(input.idempotencyKey).includes(scopeId));
});

test("a second suggestion is a different request: its scope id is new", async () => {
  const scopes: string[] = [];
  const deps = {
    billing: {} as never,
    generation: fakeGeneration(),
    payerPorts,
    describeModel: async () => ({ modelAlias: "m" }),
    loadSummaries: async () => [{ sourceId: "src-1", title: "A", summary: "s" }],
    createModelPort: ({ scopeId }: { scopeId: string }) => {
      scopes.push(scopeId);
      return model();
    },
  };
  await suggestTableColumns(suggestRequest, deps);
  await suggestTableColumns(suggestRequest, deps);
  assert.equal(new Set(scopes).size, 2);
});

test("a requester who lost workspace access fails with SOURCE_NOT_READABLE and nobody is charged", async () => {
  const loadSummaries = vi.fn();
  const createModelPort = vi.fn(() => model());
  const generation = fakeGeneration();
  await assert.rejects(
    suggestTableColumns(suggestRequest, {
      billing: {} as never,
      generation,
      payerPorts: { ...payerPorts, resolveAccess: async () => null },
      describeModel: async () => ({ modelAlias: "m" }),
      loadSummaries,
      createModelPort,
    }),
    (error: unknown) =>
      error instanceof GroundedGenerationError && error.code === "SOURCE_NOT_READABLE",
  );
  expect(loadSummaries).not.toHaveBeenCalled();
  expect(createModelPort).not.toHaveBeenCalled();
  expect(generation.suggestColumns).not.toHaveBeenCalled();
});

test("an unavailable default model fails the suggestion; no other model is tried", async () => {
  const generation = fakeGeneration();
  await assert.rejects(
    suggestTableColumns(suggestRequest, {
      billing: {} as never,
      generation,
      payerPorts,
      describeModel: async () => {
        throw new GroundedGenerationError("MODEL_UNAVAILABLE", "down");
      },
      loadSummaries: async () => [],
      createModelPort: () => model(),
    }),
    (error: unknown) =>
      error instanceof GroundedGenerationError && error.code === "MODEL_UNAVAILABLE",
  );
  expect(generation.suggestColumns).not.toHaveBeenCalled();
});

test("a source summary is the guide's when there is one, else the first 1,200 characters of the text", () => {
  assert.equal(pickSourceSummary("The guide says so.", "x".repeat(5_000)), "The guide says so.");
  assert.equal(pickSourceSummary("   ", "abc"), "abc");
  assert.equal(pickSourceSummary(null, "abc"), "abc");
  assert.equal(pickSourceSummary(null, "y".repeat(5_000)), "y".repeat(1_200));
  assert.equal(pickSourceSummary(undefined, ""), "");
  // Cut on a character boundary, never inside a surrogate pair.
  const cut = pickSourceSummary(null, "😀".repeat(1_000));
  assert.equal(cut.length, 1_200);
  assert.equal([...cut].every((char) => char === "😀"), true);
});

/* -------------------------------------------------------------- generation */

const generationRequest: TableGenerationRequest = {
  teamId: "team-1",
  workspaceId: "ws-1",
  threadId: "thread-1",
  artifactId: "art-1",
  versionNo: 1,
  userId: "user-1",
  sourceIds: ["src-1", "src-2"],
  columns: [
    { name: "Design", type: "text" },
    { name: "Participants", type: "number" },
  ],
  uiLocale: "en",
  scopeId: "job-1",
};

function sourceInput(sourceId: string, language: string | null, text = "Some text."): TableSourceInput {
  return {
    sourceId,
    documentId: `doc-${sourceId}`,
    title: sourceId,
    contentHash: `hash-${sourceId}`,
    indexed: true,
    chunks: [
      {
        chunkId: `chunk-${sourceId}`,
        sourceId,
        documentId: `doc-${sourceId}`,
        chunkNo: 0,
        headingPath: null,
        language,
        text,
      },
    ],
  };
}

const anchor: GroundedAnchorPort = { anchor: async (requests) => requests.map(() => null) };

async function runWith(
  request: Partial<TableGenerationRequest>,
  options: {
    sources?: TableSourceInput[];
    fill?: ReturnType<typeof vi.fn>;
    payerPorts?: typeof payerPorts;
    describeModel?: () => Promise<{ modelAlias: string }>;
    loadSources?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const real = await loadTableGeneration();
  const sources = options.sources ?? [sourceInput("src-1", "en"), sourceInput("src-2", "en")];
  const content = tableContentFixture({
    sources: sources.map(({ sourceId, documentId, contentHash }) => ({
      sourceId,
      documentId,
      contentHash,
    })),
  });
  const fill =
    options.fill ??
    vi.fn(async () => ({ content, stats: content.generation.stats }));
  const loadSources =
    options.loadSources ??
    vi.fn(async () => ({
      sources,
      snapshots: sources.map(({ sourceId, documentId, title, contentHash }) => ({
        sourceId,
        documentId,
        title,
        contentHash,
      })),
    }));
  const createModelPort = vi.fn(() => model());
  const outcome = await runTableGeneration(
    { ...generationRequest, ...request },
    {
      billing: {} as never,
      generation: { ...real, fillTable: fill as never },
      payerPorts: options.payerPorts ?? payerPorts,
      describeModel: options.describeModel ?? (async () => ({ modelAlias: "deepseek/test" })),
      loadSources: loadSources as never,
      createModelPort,
      createAnchorPort: () => anchor,
    },
  );
  return { outcome, fill, loadSources, createModelPort };
}

test("generates from the sources with the recipe, model and snapshots recorded", async () => {
  const { outcome, fill, createModelPort } = await runWith({ instruction: "compare" });
  expect(fill).toHaveBeenCalledTimes(1);
  const [deps, input] = fill.mock.calls[0] as unknown as [
    Record<string, unknown>,
    FillInput,
  ];
  assert.ok(deps.model && deps.anchor && deps.figures);
  assert.equal(typeof (deps.figures as { covered: unknown }).covered, "function");
  assert.equal(input.artifactId, "art-1");
  assert.equal(input.versionNo, 1);
  assert.equal(input.modelAlias, "deepseek/test");
  assert.equal(input.instruction, "compare");
  assert.equal(input.language, "en");
  assert.equal(input.previous, undefined);
  assert.deepEqual(
    input.columns.map((column) => column.name),
    ["Design", "Participants"],
  );
  assert.ok(input.columns.every((column) => /^col_[0-9a-f]{32}$/.test(column.id)));
  // The recipe is what "adjust and regenerate" starts from, ids included.
  assert.deepEqual(input.recipe, {
    instruction: "compare",
    columns: input.columns.map(({ id, name, type }) => ({ id, name, type })),
    sourceIds: ["src-1", "src-2"],
  });
  assert.deepEqual(
    outcome.sources.map((source) => source.sourceId),
    ["src-1", "src-2"],
  );
  assert.deepEqual(outcome.payer, payer);
  expect(createModelPort).toHaveBeenCalledWith(
    expect.objectContaining({ payer, scopeId: "job-1" }),
  );
});

test("the previous version's column ids are kept and its table is handed to the engine", async () => {
  const previous = tableContentFixture({
    sources: [{ sourceId: "src-1", documentId: "doc-src-1", contentHash: "hash-src-1" }],
  });
  const kept = previous.columns[0]!;
  const { fill } = await runWith({
    previous,
    columns: [
      { id: kept.id, name: "Design (renamed)", type: "text" },
      { id: "col_00000000000000000000000000000000", name: "Unknown id", type: "text" },
    ],
  });
  const input = (fill.mock.calls[0] as unknown as [unknown, FillInput])[1];
  assert.equal(input.previous, previous);
  assert.equal(input.columns[0]!.id, kept.id);
  // An id the previous version does not have is a new column.
  assert.notEqual(input.columns[1]!.id, "col_00000000000000000000000000000000");
});

test("the output language is the request's, else the sources' majority, else the UI's", async () => {
  const languageOf = async (
    request: Partial<TableGenerationRequest>,
    sources: TableSourceInput[],
  ) => {
    const { fill } = await runWith(request, { sources });
    return (fill.mock.calls[0] as unknown as [unknown, { language: string }])[1].language;
  };
  const chinese = [sourceInput("src-1", "zh"), sourceInput("src-2", "zh")];
  assert.equal(await languageOf({ language: "fr", uiLocale: "en" }, chinese), "fr");
  assert.equal(await languageOf({ uiLocale: "en" }, chinese), "zh");
  const mixed = [sourceInput("src-1", "zh"), sourceInput("src-2", "en")];
  assert.equal(await languageOf({ uiLocale: "zh-TW" }, mixed), "zh-TW");
});

test("no payer: SOURCE_NOT_READABLE before any source is read or model port created", async () => {
  const loadSources = vi.fn();
  await assert.rejects(
    runWith(
      {},
      { payerPorts: { ...payerPorts, resolveAccess: async () => null }, loadSources },
    ),
    (error: unknown) =>
      error instanceof GroundedGenerationError && error.code === "SOURCE_NOT_READABLE",
  );
  expect(loadSources).not.toHaveBeenCalled();
});

test("an unavailable default model fails before the sources are loaded", async () => {
  const loadSources = vi.fn();
  await assert.rejects(
    runWith(
      {},
      {
        loadSources,
        describeModel: async () => {
          throw new GroundedGenerationError("MODEL_UNAVAILABLE", "down");
        },
      },
    ),
    (error: unknown) =>
      error instanceof GroundedGenerationError && error.code === "MODEL_UNAVAILABLE",
  );
  expect(loadSources).not.toHaveBeenCalled();
});

test("an engine failure passes through untouched, for the job to record", async () => {
  const fill = vi.fn(async () => {
    throw new GroundedGenerationError("INSUFFICIENT_CREDITS", "no credits");
  });
  await assert.rejects(
    runWith({}, { fill }),
    (error: unknown) =>
      error instanceof GroundedGenerationError && error.code === "INSUFFICIENT_CREDITS",
  );
});
