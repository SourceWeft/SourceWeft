import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { ModelCallObservation } from "@sourceweft/model-gateway";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { GenerationCostResolver } from "./sink";

// Authorization is outside this persistence test. All trace/generation writes,
// scope lookup and row assertions use an isolated, fully migrated PostgreSQL DB.
vi.mock("../workspace", () => ({
  workspaceService: {
    findWorkspaceInOrganization: async (input: {
      workspaceId: string;
      organizationId: string;
    }) => ({
      id: input.workspaceId,
      organizationId: input.organizationId,
    }),
  },
}));

let schema: typeof import("@sourceweft/db");
let writer: typeof import("./writer");
let sinkModule: typeof import("./sink");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalWritesDisabled = process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
const teamId = randomUUID();
const workspaceId = randomUUID();

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("stream_usage");
  process.env.DATABASE_URL = isolated.url;
  process.env.LLM_OBSERVABILITY_WRITES_DISABLED = "0";
  schema = await import("@sourceweft/db");
  writer = await import("./writer");
  sinkModule = await import("./sink");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Stream observation database test",
    slug: workspaceId,
  });
}, 120_000);

afterAll(async () => {
  if (schema) await schema.closeDatabase();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalWritesDisabled === undefined)
    delete process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
  else process.env.LLM_OBSERVABILITY_WRITES_DISABLED = originalWritesDisabled;
});

async function start() {
  const { traceId } = await writer.startTrace({
    teamId,
    workspaceId,
    name: "Cancelled chat",
    strict: true,
  });
  const { spanId } = await writer.startGeneration({
    traceId,
    teamId,
    workspaceId,
    operation: "chat.stream",
    modelAlias: "chat",
    provider: "orcarouter",
    providerModel: "requested-model",
    strict: true,
    metadata: { fixture: "stream-partial" },
  });
  return { traceId, spanId, teamId, workspaceId };
}
async function row(scope: Awaited<ReturnType<typeof start>>) {
  const rows = await schema.db
    .select()
    .from(schema.llmGenerations)
    .where(
      and(
        eq(schema.llmGenerations.traceId, scope.traceId),
        eq(schema.llmGenerations.spanId, scope.spanId),
        eq(schema.llmGenerations.teamId, teamId),
        eq(schema.llmGenerations.workspaceId, workspaceId),
      ),
    );
  assert.equal(rows.length, 1, "a real persisted generation is required");
  return rows[0]!;
}
function observation(
  patch: Partial<ModelCallObservation> = {},
): ModelCallObservation {
  return {
    identity: {
      modelAlias: "chat",
      provider: "orcarouter",
      requestedProviderModel: "requested-model",
      resolvedProviderModel: "resolved-model",
      providerRequestId: "request-for-reconciliation",
    },
    provenance: {},
    ...patch,
  };
}

test("the real sink retains partial usage and provider cost on an error generation, redacting response credentials", async () => {
  const scope = await start();
  const resolveCost = vi.fn<GenerationCostResolver>(async () => {
    throw new Error("inline provider cost must not need the price book");
  });
  const sink = sinkModule.createLlmObservabilitySink({ resolveCost });
  await sink.onGenerationError!({
    traceId: scope.traceId,
    spanId: scope.spanId,
    endedAt: new Date().toISOString(),
    errorCode: "CANCELLED",
    errorMessage: "Caller stopped after receiving output",
    observation: observation({
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cacheReadTokens: 2,
        reasoningTokens: 1,
      },
      cost: {
        currency: "USD",
        inlineUsd: 0.0042,
        effectiveUsd: 0.0042,
        source: "provider_inline",
        status: "inline",
      },
      providerResponseHeaders: {
        "x-orca-request-id": "request-for-reconciliation",
        authorization: "Bearer must-never-persist",
        "set-cookie": "secret-cookie",
      },
      provenance: {
        usage: "protocol:langchain.sdk_usage",
        inlineCost: "provider:orcarouter.usage.cost_usd",
      },
    }),
  });
  const actual = await row(scope);
  assert.equal(resolveCost.mock.calls.length, 0);
  assert.equal(actual.status, "error");
  assert.equal(actual.errorCode, "CANCELLED");
  assert.equal(actual.errorMessage, "Caller stopped after receiving output");
  assert.equal(actual.inputTokens, 12);
  assert.equal(actual.outputTokens, 3);
  assert.equal(actual.totalTokens, 15);
  assert.equal(actual.cacheReadTokens, 2);
  assert.equal(actual.reasoningTokens, 1);
  assert.equal(Number(actual.providerCostUsd), 0.0042);
  assert.equal(Number(actual.providerCostInlineUsd), 0.0042);
  assert.equal(actual.providerCostSettledUsd, null);
  assert.equal(actual.providerCostSource, "provider_inline");
  assert.equal(actual.providerCostStatus, "inline");
  assert.equal(actual.resolvedProviderModel, "resolved-model");
  assert.equal(actual.providerRequestId, "request-for-reconciliation");
  assert.deepEqual(actual.providerResponseHeadersJson, {
    "x-orca-request-id": "request-for-reconciliation",
    authorization: "[REDACTED]",
    "set-cookie": "[REDACTED]",
  });
  assert.ok(actual.endedAt);
  assert.equal(actual.metadataJson.fixture, "stream-partial");
  assert.equal(JSON.stringify(actual).includes("must-never-persist"), false);
});

test("a failed stream may retain an estimate computed from received usage without becoming successful", async () => {
  const scope = await start();
  const resolveCost = vi.fn<GenerationCostResolver>(async () => ({
    providerCostUsd: 0.0015,
    costSource: "price_book",
  }));
  const sink = sinkModule.createLlmObservabilitySink({ resolveCost });
  await sink.onGenerationError!({
    traceId: scope.traceId,
    spanId: scope.spanId,
    endedAt: new Date().toISOString(),
    errorCode: "UPSTREAM",
    errorMessage: "Provider disconnected",
    providerStatusCode: 503,
    usage: {
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
    },
    attributes: {
      gatewayConfigId: randomUUID(),
      profileAlias: "chat",
      modelKind: "chat",
      executionMode: "GLOBAL",
    },
  });
  assert.equal(resolveCost.mock.calls.length, 1);
  assert.deepEqual(resolveCost.mock.calls[0]![0].usage, {
    inputTokens: 7,
    outputTokens: 2,
    totalTokens: 9,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
  });
  const actual = await row(scope);
  assert.equal(actual.status, "error");
  assert.equal(actual.errorCode, "UPSTREAM");
  assert.equal(actual.providerStatusCode, 503);
  assert.equal(actual.totalTokens, 9);
  assert.equal(actual.cacheReadTokens, 4);
  assert.equal(actual.cacheWriteTokens, 2);
  assert.equal(actual.reasoningTokens, 1);
  assert.equal(Number(actual.providerCostUsd), 0.0015);
  assert.equal(actual.providerCostSource, "price_book");
  assert.equal(actual.providerCostStatus, "estimated");
});

test("unknown usage and cost stay SQL null, while a known request keeps its pending receipt identity", async () => {
  for (const hasReceipt of [false, true]) {
    const scope = await start();
    await writer.recordGenerationError({
      ...scope,
      strict: true,
      errorCode: "TIMEOUT",
      errorMessage: "No usage arrived",
      observation: hasReceipt
        ? observation({
            cost: { currency: "USD", source: "missing", status: "pending" },
          })
        : undefined,
    });
    const actual = await row(scope);
    assert.equal(actual.status, "error");
    assert.equal(actual.errorCode, "TIMEOUT");
    assert.equal(actual.inputTokens, null);
    assert.equal(actual.outputTokens, null);
    assert.equal(actual.totalTokens, null);
    assert.equal(actual.usageJson, null);
    assert.equal(actual.providerCostUsd, null);
    assert.equal(actual.providerCostInlineUsd, null);
    assert.equal(actual.providerCostSettledUsd, null);
    assert.equal(actual.providerCostStatus, hasReceipt ? "pending" : null);
    assert.equal(
      actual.providerRequestId,
      hasReceipt ? "request-for-reconciliation" : null,
    );
  }
});

test("explicit zero usage and zero provider cost remain distinct from unknown, and raw provider fields stay redacted", async () => {
  const scope = await start();
  await writer.recordGenerationError({
    ...scope,
    strict: true,
    payloadMode: "full",
    errorCode: "CANCELLED",
    errorMessage: "Stopped",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    providerCostUsd: 0,
    metadata: { costSource: "provider_actual" },
    providerFields: {
      model: "model",
      authorization: "Bearer secret-field",
      nested: { api_key: "field-key" },
    },
  });
  const actual = await row(scope);
  assert.equal(actual.status, "error");
  assert.equal(actual.inputTokens, 0);
  assert.equal(actual.outputTokens, 0);
  assert.equal(actual.totalTokens, 0);
  assert.notEqual(actual.providerCostUsd, null);
  assert.equal(Number(actual.providerCostUsd), 0);
  assert.equal(actual.providerCostSource, "provider_inline");
  assert.equal(actual.providerFieldsJson?.mode, "full");
  assert.deepEqual(actual.providerFieldsJson?.value, {
    model: "model",
    authorization: "[REDACTED]",
    nested: { api_key: "[REDACTED]" },
  });
  assert.equal(JSON.stringify(actual).includes("secret-field"), false);
  assert.equal(JSON.stringify(actual).includes("field-key"), false);
});
