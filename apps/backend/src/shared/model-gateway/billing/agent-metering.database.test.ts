import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import {
  createLangChainChatModel,
  type ObserveSink,
} from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

const raw = vi.hoisted(() => ({
  createRawAgentChatModel: vi.fn(),
  getRawModelGatewayClient: vi.fn(async () => ({})),
}));
vi.mock("../internal/raw", () => raw);
vi.mock("../thinking-defaults", () => ({
  resolveChatThinkingWithDefaults: async (input: { thinking?: unknown }) =>
    input.thinking,
}));
vi.mock("../provider-cost-reconciliation", () => ({
  enqueueProviderCostReconciliation: vi.fn(),
}));

let schema: typeof import("@sourceweft/db");
let writer: typeof import("../../../modules/llm-observability/writer");
let sink: ObserveSink;
let openGateway: typeof import("../billed-client").openBilledModelGateway;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let server: Server;
let baseUrl: string;
let failPrimary = false;
const requests: string[] = [];
const teamId = randomUUID(),
  workspaceId = randomUUID();
const originalUrl = process.env.DATABASE_URL;
const originalWritesDisabled = process.env.LLM_OBSERVABILITY_WRITES_DISABLED;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("agent_metering");
  process.env.DATABASE_URL = isolated.url;
  process.env.LLM_OBSERVABILITY_WRITES_DISABLED = "0";
  schema = await import("@sourceweft/db");
  writer = await import("../../../modules/llm-observability/writer");
  const { createLlmObservabilitySink } =
    await import("../../../modules/llm-observability/sink");
  sink = createLlmObservabilitySink({ resolveCost: async () => null });
  ({ openBilledModelGateway: openGateway } = await import("../billed-client"));
  await schema.db
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      organizationId: teamId,
      name: "Agent metering",
      slug: workspaceId,
    });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(req.url!);
      if (failPrimary && req.url!.startsWith("/primary/")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "fixture unavailable", type: "server_error" },
          }),
        );
        return;
      }
      const input = JSON.parse(body);
      const common = {
        id: randomUUID(),
        object: "chat.completion.chunk",
        created: 1,
        model: input.model,
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "observed" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  raw.createRawAgentChatModel.mockImplementation(async (input) => {
    const composed: ObserveSink = {};
    for (const handler of [
      "onGenerationStart",
      "onGenerationEnd",
      "onGenerationError",
    ] as const) {
      composed[handler] = async (event: never) => {
        await sink[handler]?.(event);
        await input.observeSink?.[handler]?.(event);
      };
    }
    return createLangChainChatModel({
      modelAlias: input.modelAlias,
      execution: input.execution,
      config: {
        maxRetries: 0,
        providers: {
          "fixture-primary": {
            kind: "openai-compatible",
            apiKey: "fixture-key",
            baseUrl: baseUrl + "/primary/v1",
          },
          "fixture-secondary": {
            kind: "openai-compatible",
            apiKey: "fixture-key",
            baseUrl: baseUrl + "/secondary/v1",
          },
        },
        modelRoutes: {
          "fixture-chat": {
            strategy: "priority",
            targets: [
              {
                provider: "fixture-primary",
                model: "fixture-model",
                priority: 1,
              },
              {
                provider: "fixture-secondary",
                model: "fixture-model",
                priority: 2,
              },
            ],
          },
        },
        observeSink: composed,
      },
    });
  });
}, 120_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await schema?.closeDatabase();
  await isolated?.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  if (originalWritesDisabled === undefined)
    delete process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
  else process.env.LLM_OBSERVABILITY_WRITES_DISABLED = originalWritesDisabled;
});

async function build(covered = false) {
  const { traceId } = await writer.startTrace({
    teamId,
    workspaceId,
    name: "Real SDK observation",
    strict: true,
  });
  const payer = randomUUID();
  const billing = {
    getSummary: vi.fn(async () => ({
      teamId: payer,
      billingMode: "enforced",
      credits: { available: 100, consumedThisCycle: 0 },
    })),
  } as unknown as ContentBillingPort;
  // Pricing is outside this test; scope settlement and observation run for real.
  const meterUsage = vi.fn(async (input) => ({
    billing: {
      teamId: input.teamId,
      consumedCredits: 2,
      availableCredits: 98,
      consumedThisCycle: 2,
      idempotencyReplayed: false,
    },
    cost: {
      providerCostUsd: 0.01,
      pricingSnapshot: null,
      costSource: "price_book",
      missingPriceComponents: [],
    },
    billedBy: "provider_cost" as const,
    skipReason: null,
  }));
  const { gateway, scope } = await openGateway({
    billing,
    meterUsage: meterUsage as never,
    context: {
      teamId: payer,
      workspaceId,
      actorUserId: "actor",
      feature: "chat",
      intent: covered
        ? { mode: "covered", coveredBy: "byok" }
        : { mode: "billed" },
      scopeKind: "thread-turn",
      scopeId: traceId,
    },
  });
  const model = await gateway.agentChatModel({
    modelAlias: "fixture-chat",
    observationContext: { traceId, teamId, workspaceId },
    billing: {
      modelKind: "chat",
      profileAlias: "fixture-chat",
      gatewayConfigId: undefined as never,
    },
  });
  const generations = () =>
    schema.db
      .select()
      .from(schema.llmGenerations)
      .where(
        and(
          eq(schema.llmGenerations.traceId, traceId),
          eq(schema.llmGenerations.workspaceId, workspaceId),
        ),
      );
  return { model, scope, payer, traceId, meterUsage, generations };
}

test("real SDK calls retain trace identity through composition and concurrent billing scopes", async () => {
  const [a, b] = await Promise.all([build(), build()]);
  type Composable = {
    withConfig(c: unknown): {
      bindTools(t: unknown[]): { invoke(m: unknown): Promise<unknown> };
    };
  };
  await Promise.all(
    [a, b].map(({ model }) =>
      (model as unknown as Composable)
        .withConfig({ tags: ["metering"] })
        .bindTools([])
        .invoke([new HumanMessage("hello")]),
    ),
  );
  for (const testCase of [a, b]) {
    const rows = await testCase.generations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider, "fixture-primary");
    assert.equal(rows[0]!.teamId, teamId);
    assert.equal(rows[0]!.totalTokens, 12);
    assert.equal(rows[0]!.status, "ok");
    assert.equal(testCase.scope.meteredCalls().length, 1);
    assert.equal(
      testCase.scope.meteredCalls()[0]!.observation?.traceId,
      testCase.traceId,
    );
    assert.equal(testCase.meterUsage.mock.calls[0]![0].teamId, testCase.payer);
  }
});

test("covered streaming calls retain real usage and generation without a platform charge", async () => {
  const c = await build(true);
  const stream = await c.model.stream([new HumanMessage("stream")]);
  for await (const _chunk of stream) {
    /* drain through settlement */
  }
  assert.equal((await c.generations())[0]!.totalTokens, 12);
  assert.equal(c.scope.meteredCalls().length, 1);
  assert.equal(c.scope.meteredCalls()[0]!.billingStatus, "covered");
  assert.equal(c.scope.meteredCalls()[0]!.consumedCredits, 0);
  assert.equal(c.meterUsage.mock.calls.length, 0);
});

test("failover attempts are observed individually while one logical call keeps its settlement", async () => {
  const c = await build();
  failPrimary = true;
  try {
    await c.model.invoke([new HumanMessage("try available provider")]);
  } finally {
    failPrimary = false;
  }
  const rows = await c.generations();
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((r) => r.provider === "fixture-primary")?.status,
    "error",
  );
  assert.equal(
    rows.find((r) => r.provider === "fixture-secondary")?.status,
    "ok",
  );
  assert.equal(c.scope.meteredCalls().length, 1);
  assert.equal(
    c.scope.meteredCalls()[0]!.observation?.identity.provider,
    "fixture-secondary",
  );
  assert.equal(c.meterUsage.mock.calls.length, 1);
});
