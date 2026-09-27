import assert from "node:assert/strict";
import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createModelGateway } from "@sourceweft/model-gateway";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { emptyModelInfo } from "./model-catalog/types";

/**
 * The system model against real PostgreSQL and a real local HTTP Provider:
 * the global gateway configuration is synchronized from a file exactly as in
 * deployment, with the borrowed Provider disabled for GLOBAL traffic and its
 * own global key present. Only external catalog metadata is replaced.
 */

let schema: typeof import("@sourceweft/db");
let runtime: typeof import("./runtime");
let system: typeof import("./system-client");
let syncConfig: typeof import("./config-sync").syncGlobalModelGatewayConfigFromFile;
let registry: typeof import("./model-catalog/registry").modelCatalog;
let backendConfig: typeof import("../config").config;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let server: Server | undefined;
let directory: string | undefined;
let baseUrl: string;
let originalSystemModel: typeof backendConfig.systemModel;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalWritesDisabled = process.env.LLM_OBSERVABILITY_WRITES_DISABLED;

const enabledEnv = "SOURCEWEFT_SYSTEM_MODEL_TEST_ENABLED";
const globalKeyEnv = "SOURCEWEFT_SYSTEM_MODEL_TEST_GLOBAL_KEY";
const GLOBAL_KEY = "sk-global-SECRET-db-test";
const DEDICATED_KEY = "sk-dedicated-SECRET-db-test";

const requests: Array<{
  path: string;
  headers: IncomingHttpHeaders;
  payload: Record<string, unknown>;
}> = [];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("system_model");
  process.env.DATABASE_URL = isolated.url;
  // Observability writes stay on, so an unwanted generation row would land.
  process.env.LLM_OBSERVABILITY_WRITES_DISABLED = "0";
  schema = await import("@sourceweft/db");
  runtime = await import("./runtime");
  system = await import("./system-client");
  ({ syncGlobalModelGatewayConfigFromFile: syncConfig } =
    await import("./config-sync"));
  ({ modelCatalog: registry } = await import("./model-catalog/registry"));
  ({ config: backendConfig } = await import("../config"));
  originalSystemModel = { ...backendConfig.systemModel };
  directory = await mkdtemp(join(tmpdir(), "sourceweft-system-model-"));
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      requests.push({ path: req.url!, headers: { ...req.headers }, payload });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            id: "system-chat",
            object: "chat.completion",
            model: "site-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "system reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}, 120_000);

beforeEach(() => {
  vi.stubEnv(enabledEnv, "false");
  vi.stubEnv(globalKeyEnv, GLOBAL_KEY);
  requests.length = 0;
  vi.spyOn(registry, "refresh").mockResolvedValue(undefined);
  vi.spyOn(registry, "resolve").mockImplementation((id) => ({
    ...emptyModelInfo(id),
    modality: id.includes("embedding") ? "embedding" : "chat",
    sources: ["system-model-fixture"],
  }));
});

afterEach(async () => {
  if (schema) {
    await schema.db.delete(schema.modelGatewayRoutes);
    await schema.db.delete(schema.modelGatewayProviderConfigs);
    await schema.db.delete(schema.modelGatewayProfiles);
    await schema.db.delete(schema.modelGatewayConfigs);
    await schema.db.delete(schema.modelGatewayConfigVersions);
  }
  if (backendConfig)
    Object.assign(backendConfig.systemModel, originalSystemModel);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server!.closeAllConnections();
      server!.close(() => resolve());
    });
  if (schema) await schema.database.end();
  await isolated?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalWritesDisabled === undefined)
    delete process.env.LLM_OBSERVABILITY_WRITES_DISABLED;
  else process.env.LLM_OBSERVABILITY_WRITES_DISABLED = originalWritesDisabled;
});

/**
 * A custom site declared the way the backend README describes (disabled for
 * GLOBAL traffic, no catalog discovery). The configuration also needs the
 * embedding profile every deployment must have.
 */
async function synchronize() {
  const configPath = join(directory!, "gateway.json");
  const profile = {
    gatewaySlug: "site-system",
    providerName: "site",
    isActive: true,
    isDefault: true,
  };
  await writeFile(
    configPath,
    JSON.stringify({
      gateways: [
        {
          slug: "site-system",
          providerName: "site",
          providerKind: "openai-compatible",
          baseUrl,
          apiKeyEnv: globalKeyEnv,
          activation: { env: enabledEnv, default: false },
          supports: ["chat", "json_schema", "embeddings"],
          timeoutMs: 5_000,
          maxRetries: 0,
          isDefault: true,
          modelCatalog: { enabled: false },
        },
      ],
      chatProfiles: [
        {
          ...profile,
          profileAlias: "site-chat-default",
          modelAlias: "site-chat-default",
          targetModel: "site-model",
        },
      ],
      embeddingProfiles: [
        {
          ...profile,
          profileId: "site-embedding-profile",
          profileAlias: "site-embedding-default",
          modelAlias: "site-embedding-default",
          targetModel: "site-embedding",
          requestedDimensions: 2,
          vectorStrategy: "exact",
        },
      ],
    }),
  );
  await syncConfig(configPath, { syncPricing: false });
}

async function countRows() {
  const count = async (table: string) => {
    const result = await schema.database.query<{ count: string }>(
      `select count(*)::text as count from ${table}`,
    );
    return Number(result.rows[0]!.count);
  };
  return {
    usageLedgers: await count("usage_ledgers"),
    llmGenerations: await count("llm_generations"),
    llmTraces: await count("llm_traces"),
    llmSpans: await count("llm_spans"),
    routes: await count("model_gateway_routes"),
    profiles: await count("model_gateway_profiles"),
    providers: await count("model_gateway_provider_configs"),
    gateways: await count("model_gateway_configs"),
    versions: await count("model_gateway_config_versions"),
  };
}

test("a GLOBAL-disabled Provider lends its definition; the call carries the dedicated key and writes nothing", async () => {
  await synchronize();
  const routed = await runtime.loadRoutedGatewayConfig();
  assert.ok(routed);
  // Disabled for tenant traffic even though its global key is present.
  assert.equal(routed.providers.site!.enabled, false);
  assert.equal(routed.providers.site!.globalReady, false);
  assert.equal(routed.providers.site!.hasGlobalApiKey, true);
  const tenant = createModelGateway({
    ...runtime.buildRoutedModelGatewayConfig(routed),
    observeSink: undefined,
  });
  await assert.rejects(
    tenant.chat.complete({
      model: "site-chat-default",
      messages: [{ role: "user", content: "hi" }],
    }),
    /No globally ready route target/,
  );
  assert.equal(requests.length, 0);

  Object.assign(backendConfig.systemModel, {
    enabled: true,
    provider: "site",
    apiKey: DEDICATED_KEY,
    model: "site-model",
  });
  const readiness = await system.getSystemModelReadiness();
  assert.equal(readiness.ready, true, readiness.reason ?? undefined);

  const before = await countRows();
  const result = await system.withSystemModel(
    {
      purpose: "mcp_market.classify",
      subjectRef: "mcp-repository:test",
      scopeId: "system-model-db-test",
    },
    (chat) =>
      chat.complete({ messages: [{ role: "user", content: "classify" }] }),
  );
  assert.equal(result.raw.content, "system reply");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/v1/chat/completions");
  assert.equal(requests[0]!.headers.authorization, `Bearer ${DEDICATED_KEY}`);
  assert.equal(requests[0]!.payload.model, "site-model");
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(GLOBAL_KEY));

  // No billing, no observability, and the in-memory route never reached the
  // tables the user catalog is read from.
  assert.deepEqual(await countRows(), before);
  const aliases = await schema.database.query<{ alias: string }>(
    "select alias from model_gateway_routes order by alias",
  );
  assert.deepEqual(
    aliases.rows.map((row) => row.alias),
    ["site-chat-default", "site-embedding-default"],
  );
});

test("an empty dedicated key is not ready and the global key is never sent", async () => {
  vi.stubEnv(enabledEnv, "true");
  await synchronize();
  const routed = await runtime.loadRoutedGatewayConfig();
  // The Provider is ready for GLOBAL traffic with its own key...
  assert.equal(routed!.providers.site!.globalReady, true);
  Object.assign(backendConfig.systemModel, {
    enabled: true,
    provider: "site",
    apiKey: "",
    model: "site-model",
  });
  // ...which the system model still refuses to borrow.
  await assert.rejects(
    system.withSystemModel(
      {
        purpose: "skill_market.overview",
        subjectRef: "skill-version:test",
        scopeId: "system-model-db-test-2",
      },
      (chat) =>
        chat.complete({ messages: [{ role: "user", content: "describe" }] }),
    ),
    system.SystemModelUnavailableError,
  );
  assert.equal(requests.length, 0);
});
