import { adaptBillingTestPort } from "../../test/billing-runtime";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import {
  createModelGateway,
  TargetHealthRegistry,
} from "@sourceweft/model-gateway";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { LegacyBillingTestPort as ContentBillingPort } from "../../test/billing-runtime";
import type { GenerationCostResolver } from "../../modules/llm-observability/sink";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

// Choose the test's real gateway instead of a deployment registry. SDK calls,
// response capture, covered settlement, sink and all DB operations remain real.
const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));
vi.mock("./internal/raw", () => rawMocks);
vi.mock("../../modules/workspace", () => ({
  workspaceService: {
    findWorkspaceInOrganization: async (input: {
      workspaceId: string;
      organizationId: string;
    }) => ({ id: input.workspaceId, organizationId: input.organizationId }),
  },
}));

let schema: typeof import("@sourceweft/db");
let writer: typeof import("../../modules/llm-observability/writer");
let sinkModule: typeof import("../../modules/llm-observability/sink");
let billed: typeof import("./billed-client");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousWritesDisabled = process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
const teamId = randomUUID();
const workspaceId = randomUUID();
const gatewayConfigId = randomUUID();

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("embedding_usage");
  process.env.DATABASE_URL = isolated.url;
  process.env.LLM_OBSERVABILITY_WRITES_DISABLED = "0";
  schema = await import("@sourceweft/db");
  writer = await import("../../modules/llm-observability/writer");
  sinkModule = await import("../../modules/llm-observability/sink");
  billed = await import("./billed-client");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Embedding usage integration",
    slug: workspaceId,
  });
  await schema.db.insert(schema.modelGatewayConfigs).values({
    id: gatewayConfigId,
    slug: gatewayConfigId,
    baseUrl: "https://embedding.test.invalid/v1",
  });
}, 120_000);

afterAll(async () => {
  if (schema) await schema.closeDatabase();
  if (isolated) await isolated.close();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousWritesDisabled === undefined)
    delete process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
  else process.env.LLM_OBSERVABILITY_WRITES_DISABLED = previousWritesDisabled;
});

const requestMetadata = () => ({
  teamId,
  workspaceId,
  gatewayConfigId,
  profileAlias: "embedding",
  modelKind: "embedding",
  executionMode: "GLOBAL",
});
async function startTrace() {
  return (
    await writer.startTrace({
      teamId,
      workspaceId,
      name: "Embedding usage",
      strict: true,
    })
  ).traceId;
}
async function generation(traceId: string) {
  const rows = await schema.db
    .select()
    .from(schema.llmGenerations)
    .where(
      and(
        eq(schema.llmGenerations.traceId, traceId),
        eq(schema.llmGenerations.teamId, teamId),
        eq(schema.llmGenerations.workspaceId, workspaceId),
      ),
    );
  assert.equal(rows.length, 1);
  return rows[0]!;
}
async function inputs(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const body = (await new Request(input, init).json()) as {
    input: string | string[];
  };
  return Array.isArray(body.input) ? body.input : [body.input];
}
function response(texts: string[], id?: string, usage = true) {
  return new Response(
    JSON.stringify({
      object: "list",
      model: "embedding-model",
      data: texts.map((_text, index) => ({
        object: "embedding",
        index,
        embedding: [1, 0],
      })),
      ...(usage ? { usage: { prompt_tokens: 37, total_tokens: 37 } } : {}),
    }),
    {
      headers: {
        "content-type": "application/json",
        ...(id ? { "x-request-id": id } : {}),
      },
    },
  );
}
function runtime(fetch: typeof globalThis.fetch) {
  const resolveCost = vi.fn<GenerationCostResolver>(async ({ usage }) =>
    usage?.inputTokens === undefined
      ? { providerCostUsd: null, costSource: "missing_usage" }
      : {
          providerCostUsd: usage.inputTokens * 0.0001,
          costSource: "price_book",
        },
  );
  const gateway = createModelGateway({
    providers: {
      openai: {
        kind: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://embedding.test.invalid/v1",
      },
    },
    modelRoutes: {
      embedding: {
        strategy: "priority",
        targets: [
          { provider: "openai", model: "embedding-model", priority: 1 },
        ],
      },
    },
    fetch,
    maxRetries: 0,
    targetHealth: new TargetHealthRegistry(),
    observeSink: sinkModule.createLlmObservabilitySink({ resolveCost }),
  });
  return { gateway, resolveCost };
}
const texts = () => Array.from({ length: 513 }, (_, index) => `text-${index}`);

test("real SDK two-batch usage=74 and receipt IDs persist; covered ingestion and retrieval never meter credits", async () => {
  for (const coveredBy of [
    "covered_by_ingestion_page",
    "model_kind_not_user_billed",
  ] as const) {
    const traceId = await startTrace();
    let requests = 0;
    const { gateway, resolveCost } = runtime(async (input, init) => {
      requests++;
      const values = await inputs(input, init);
      return response(values, values[0]);
    });
    rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);
    const meterUsage = vi.fn(async () => {
      throw new Error("Covered embedding must not reach model metering");
    });
    const billing: ContentBillingPort = adaptBillingTestPort({
      getSummary: vi.fn(
        async () =>
          ({
            teamId,
            billingMode: "enforced",
            credits: { available: 0, consumedThisCycle: 0 },
          }) as BillingSummaryResponse,
      ),
      meterConsume: vi.fn(async () => {
        throw new Error("Covered embedding must not consume credits");
      }),
      meterIngestion: vi.fn(async () => {
        throw new Error(
          "Embedding tokens must not add an ingestion page charge",
        );
      }),
    });
    const result = await billed.withBilledModelGateway(
      {
        billing,
        meterUsage,
        context: {
          teamId,
          workspaceId,
          actorUserId: "test-user",
          feature: "source_ingestion",
          scopeKind: "worker-job",
          scopeId: traceId,
          intent: { mode: "covered", coveredBy },
        },
      },
      async (client, scope) => {
        const embeddings = await client.embeddings.embedBatch(
          { model: "embedding", texts: texts(), encodingFormat: "float" },
          {
            traceId,
            operation: "embeddings.embedBatch",
            modelKind: "embedding",
            profileAlias: "embedding",
            gatewayConfigId,
          },
        );
        assert.equal(scope.meteredCalls().length, 1);
        assert.equal(scope.meteredCalls()[0]!.billingStatus, "covered");
        assert.equal(scope.meteredCalls()[0]!.consumedCredits, 0);
        return embeddings;
      },
    );
    assert.equal(requests, 2);
    assert.equal(result.embeddings.length, 513);
    assert.equal(result.usage?.totalTokens, 74);
    assert.equal(resolveCost.mock.calls.length, 1);
    assert.equal(resolveCost.mock.calls[0]![0].usage?.totalTokens, 74);
    assert.equal(meterUsage.mock.calls.length, 0);
    assert.equal(vi.mocked(billing.meterConsume).mock.calls.length, 0);
    assert.equal(vi.mocked(billing.meterIngestion).mock.calls.length, 0);
    const row = await generation(traceId);
    assert.equal(row.status, "ok");
    assert.equal(row.inputTokens, 74);
    assert.equal(row.totalTokens, 74);
    assert.equal(row.outputTokens, null);
    assert.equal(
      row.providerRequestId,
      null,
      "two physical requests must not masquerade as a single receipt",
    );
    assert.deepEqual(
      (row.normalizationJson?.providerRequestIds as string[]).sort(),
      ["text-0", "text-512"],
    );
    assert.equal(Number(row.providerCostUsd), 0.0074);
    assert.equal(row.providerCostSource, "price_book");
    assert.equal(row.providerCostStatus, "estimated");
  }
});

test("a later SDK batch failure persists the earlier batch's usage and identity on an error generation", async () => {
  const traceId = await startTrace();
  const { gateway } = runtime(async (input, init) => {
    const values = await inputs(input, init);
    if (values[0] === "text-512") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return new Response(
        JSON.stringify({ error: { message: "second batch rejected" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return response(values, "successful-partial-batch");
  });
  await assert.rejects(
    () =>
      gateway.embeddings.embedBatch(
        { model: "embedding", texts: texts() },
        { traceId, metadata: requestMetadata() },
      ),
    /second batch rejected/,
  );
  const row = await generation(traceId);
  assert.equal(row.status, "error");
  assert.equal(row.errorCode, "BAD_REQUEST");
  assert.equal(row.inputTokens, 37);
  assert.equal(row.totalTokens, 37);
  assert.equal(row.outputTokens, null);
  assert.deepEqual(row.normalizationJson?.providerRequestIds, [
    "successful-partial-batch",
  ]);
  assert.ok(
    (row.normalizationJson?.diagnostics as { code: string }[]).some(
      (item) => item.code === "EMBEDDING_BATCH_INCOMPLETE",
    ),
  );
  assert.equal(Number(row.providerCostUsd), 0.0037);
  assert.equal(row.providerCostSource, "price_book");
  assert.equal(row.providerCostStatus, "estimated");
});

test("a real successful embedding response without usage leaves tokens and provider cost NULL", async () => {
  const traceId = await startTrace();
  const { gateway } = runtime(async (input, init) =>
    response(await inputs(input, init), undefined, false),
  );
  const result = await gateway.embeddings.embed(
    { model: "embedding", text: "unknown usage" },
    { traceId, metadata: requestMetadata() },
  );
  assert.equal(result.usage, undefined);
  const row = await generation(traceId);
  assert.equal(row.status, "ok");
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(row.totalTokens, null);
  assert.equal(row.usageJson, null);
  assert.equal(row.providerCostUsd, null);
  assert.equal(row.providerRequestId, null);
  assert.equal(row.normalizationJson?.providerRequestIds, undefined);
  assert.equal(row.providerCostSource, "missing");
});
