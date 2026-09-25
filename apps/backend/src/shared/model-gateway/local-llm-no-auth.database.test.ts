import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createModelGateway } from "@sourceweft/model-gateway";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { emptyModelInfo } from "./model-catalog/types";

let schema: typeof import("@sourceweft/db");
let runtime: typeof import("./runtime");
let syncConfig: typeof import("./config-sync").syncGlobalModelGatewayConfigFromFile;
let loadConfig: typeof import("./global-config").loadGlobalModelGatewayConfig;
let registry: typeof import("./model-catalog/registry").modelCatalog;
let backendConfig: typeof import("../config").config;
let encryptTeamSecret: typeof import("../team-secrets").encryptTeamSecret;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let server: Server | undefined;
let directory: string | undefined;
let configPath: string;
let baseUrl: string;
let originalOrigins: string[];
const originalDatabaseUrl = process.env.DATABASE_URL;
const enabledEnv = "SOURCEWEFT_NOAUTH_TEST_ENABLED";
const declaredKeyEnv = "SOURCEWEFT_NOAUTH_TEST_REQUIRED_KEY";
const sdkEnvironment = {
  OPENAI_API_KEY: "ambient-api-secret-noauth-test",
  OPENAI_ADMIN_KEY: "ambient-admin-secret-noauth-test",
  OPENAI_CUSTOM_HEADERS:
    "X-Ambient-Secret: ambient-header-secret-noauth-test\nAuthorization: Bearer ambient-authorization-noauth-test\nX-Api-Key: ambient-x-api-key-noauth-test",
};
const requests: Array<{
  path: string;
  headers: IncomingHttpHeaders;
  payload: Record<string, unknown>;
}> = [];
let teamId: string;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("local_noauth");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  runtime = await import("./runtime");
  ({ syncGlobalModelGatewayConfigFromFile: syncConfig } =
    await import("./config-sync"));
  ({ loadGlobalModelGatewayConfig: loadConfig } =
    await import("./global-config"));
  ({ modelCatalog: registry } = await import("./model-catalog/registry"));
  ({ config: backendConfig } = await import("../config"));
  ({ encryptTeamSecret } = await import("../team-secrets"));
  originalOrigins = backendConfig.llmAllowedInternalOrigins;
  directory = await mkdtemp(join(tmpdir(), "sourceweft-local-noauth-"));
  configPath = join(directory, "gateway.json");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      requests.push({ path: req.url!, headers: { ...req.headers }, payload });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") {
        res.end(
          JSON.stringify({
            data: [{ id: "local-chat" }, { id: "local-embedding" }],
          }),
        );
      } else if (req.url === "/v1/embeddings") {
        const count = Array.isArray(payload.input) ? payload.input.length : 1;
        res.end(
          JSON.stringify({
            data: Array.from({ length: count }, (_, index) => {
              const vector = [0.25 + index, 0.75];
              return {
                index,
                embedding:
                  payload.encoding_format === "base64"
                    ? Buffer.from(new Float32Array(vector).buffer).toString(
                        "base64",
                      )
                    : vector,
              };
            }),
            usage: { prompt_tokens: count, total_tokens: count },
          }),
        );
      } else if (req.url === "/v1/chat/completions" && payload.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        const chunk = {
          id: "local-stream",
          object: "chat.completion.chunk",
          model: "local-chat",
        };
        res.end(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "local stream" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
        );
      } else if (req.url === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            id: "local-chat",
            object: "chat.completion",
            model: "local-chat",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "local reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
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

beforeEach(async () => {
  // No developer allowlist/activation/key may satisfy these isolated fixtures.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv(enabledEnv, "true");
  vi.stubEnv(declaredKeyEnv, "");
  for (const [name, value] of Object.entries(sdkEnvironment))
    vi.stubEnv(name, value);
  backendConfig.llmAllowedInternalOrigins = [];
  requests.length = 0;
  [teamId, workspaceId, userId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      organizationId: teamId,
      name: "Local no-auth test",
      slug: workspaceId,
    });
  // Only external capability/pricing metadata is replaced. Config parsing,
  // persistence, credentials, real SDK transports and localhost HTTP stay real.
  vi.spyOn(registry, "refresh").mockResolvedValue(undefined);
  vi.spyOn(registry, "resolve").mockImplementation((id) => ({
    ...emptyModelInfo(id),
    modality: id.includes("embedding") ? "embedding" : "chat",
    toolCall: false,
    sources: ["local-noauth-fixture"],
  }));
});

afterEach(async () => {
  if (schema) {
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    await schema.db
      .delete(schema.teamDataKeys)
      .where(eq(schema.teamDataKeys.teamId, teamId));
    await schema.database.query("delete from organization where id = $1", [
      teamId,
    ]);
    await schema.db.delete(schema.modelGatewayRoutes);
    await schema.db.delete(schema.modelGatewayProviderConfigs);
    await schema.db.delete(schema.modelGatewayProfiles);
    await schema.db.delete(schema.modelGatewayConfigs);
    await schema.db.delete(schema.modelGatewayConfigVersions);
  }
  backendConfig.llmAllowedInternalOrigins = originalOrigins;
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
});

async function configure(
  options: { enabled?: boolean; declaredKey?: boolean; catalog?: boolean } = {},
) {
  vi.stubEnv(enabledEnv, options.enabled === false ? "false" : "true");
  const common = {
    gatewaySlug: "local-noauth",
    providerName: "local",
    isActive: true,
    isDefault: true,
  };
  await writeFile(
    configPath,
    JSON.stringify({
      gateways: [
        {
          slug: common.gatewaySlug,
          providerName: "local",
          providerKind: "openai-compatible",
          baseUrl,
          activation: { env: enabledEnv, default: false },
          ...(options.declaredKey ? { apiKeyEnv: declaredKeyEnv } : {}),
          defaultHeaders: { "X-Local-Fixture": "sourceweft" },
          supports: ["chat", "embeddings"],
          timeoutMs: 5_000,
          maxRetries: 0,
          isDefault: true,
          modelCatalog: {
            enabled: options.catalog ?? true,
            kinds: ["chat", "embedding"],
          },
        },
      ],
      chatProfiles: [
        {
          ...common,
          profileAlias: "local-chat-default",
          modelAlias: "local-chat-default",
          targetModel: "local-chat",
        },
      ],
      embeddingProfiles: [
        {
          ...common,
          profileId: "local-embedding-profile",
          profileAlias: "local-embedding-default",
          modelAlias: "local-embedding-default",
          targetModel: "local-embedding",
          requestedDimensions: 2,
          vectorStrategy: "exact",
        },
      ],
    }),
  );
  await syncConfig(configPath, { syncPricing: false });
  const routed = await runtime.loadRoutedGatewayConfig();
  assert.ok(routed);
  return {
    routed,
    gateway: createModelGateway({
      ...runtime.buildRoutedModelGatewayConfig(routed),
      observeSink: undefined,
    }),
  };
}
const messages = [{ role: "user" as const, content: "hello" }];
function assertNoAmbientCredentials() {
  for (const request of requests) {
    assert.equal(request.headers["x-ambient-secret"], undefined);
    assert.equal(request.headers["x-api-key"], undefined);
    const wire = JSON.stringify(request);
    for (const secret of [
      "ambient-api-secret",
      "ambient-admin-secret",
      "ambient-header-secret",
      "ambient-authorization",
      "ambient-x-api-key",
    ])
      assert.equal(wire.includes(secret), false, `wire must exclude ${secret}`);
  }
}

for (const ambient of [false, true]) {
  test(`GLOBAL no-key configuration reaches local chat, stream, embedding and catalog with SDK env ${ambient ? "present" : "absent"}`, async () => {
    if (!ambient)
      for (const name of Object.keys(sdkEnvironment))
        vi.stubEnv(name, undefined);
    const { routed, gateway } = await configure();
    assert.deepEqual(
      {
        enabled: routed.providers.local!.enabled,
        configured: routed.providers.local!.configured,
        globalReady: routed.providers.local!.globalReady,
        requiresGlobalApiKey: routed.providers.local!.requiresGlobalApiKey,
        hasGlobalApiKey: routed.providers.local!.hasGlobalApiKey,
        apiKey: routed.providers.local!.apiKey,
      },
      {
        enabled: true,
        configured: true,
        globalReady: true,
        requiresGlobalApiKey: false,
        hasGlobalApiKey: false,
        apiKey: undefined,
      },
    );
    const [persisted] = await schema.db
      .select()
      .from(schema.modelGatewayConfigs);
    assert.equal(persisted!.apiKeyEncrypted, null);
    assert.equal(persisted!.isActive, true);
    assert.equal(
      (await gateway.chat.complete({ model: "local-chat-default", messages }))
        .raw.content,
      "local reply",
    );
    let text = "";
    for await (const event of gateway.chat.stream({
      model: "local-chat-default",
      messages,
    })) {
      if (event.type === "error") throw new Error(JSON.stringify(event.error));
      if (event.type === "chunk") text += event.chunk.content;
    }
    assert.equal(text, "local stream");
    assert.deepEqual(
      (
        await gateway.embeddings.embed({
          model: "local-embedding-default",
          text: "hello",
        })
      ).embedding,
      [0.25, 0.75],
    );
    assert.deepEqual(
      (
        await gateway.embeddings.embedBatch({
          model: "local-embedding-default",
          texts: ["one", "two"],
        })
      ).embeddings,
      [
        [0.25, 0.75],
        [1.25, 0.75],
      ],
    );
    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/v1/models",
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/embeddings",
        "/v1/embeddings",
      ],
    );
    assert.ok(
      requests.every((request) => request.headers.authorization === undefined),
    );
    assert.ok(
      requests.every(
        (request) => request.headers["x-local-fixture"] === "sourceweft",
      ),
    );
    assertNoAmbientCredentials();
    const before = await loadConfig(configPath);
    vi.stubEnv("OPENAI_API_KEY", "rotated-ambient-key-noauth-test");
    assert.equal(
      (await loadConfig(configPath))?.versionHash,
      before?.versionHash,
      "undeclared SDK credentials never enter the deployment fingerprint",
    );
  });
}

for (const scenario of [
  { enabled: false, declaredKey: false, configured: true },
  { enabled: true, declaredKey: true, configured: false },
]) {
  test(`${scenario.enabled ? "missing declared key" : "disabled no-auth Provider"} never enters GLOBAL routing or catalog discovery`, async () => {
    const { routed, gateway } = await configure(scenario);
    const provider = routed.providers.local!;
    assert.equal(provider.enabled, scenario.enabled);
    assert.equal(provider.configured, scenario.configured);
    assert.equal(provider.globalReady, false);
    assert.equal(provider.requiresGlobalApiKey, scenario.declaredKey);
    assert.equal(provider.hasGlobalApiKey, false);
    await assert.rejects(
      gateway.chat.complete({ model: "local-chat-default", messages }),
      /No globally ready route target/,
    );
    await assert.rejects(
      gateway.embeddings.embed({
        model: "local-embedding-default",
        text: "query",
      }),
      /No globally ready route target/,
    );
    assert.deepEqual(requests, []);
    assert.equal(vi.mocked(registry.refresh).mock.calls.length, 0);
    const [persisted] = await schema.db
      .select()
      .from(schema.modelGatewayConfigs);
    assert.equal(persisted!.isActive, scenario.enabled);
    assert.equal(persisted!.apiKeyEncrypted, null);
  });
}

test("GLOBAL no-auth permission cannot satisfy missing, inactive, empty or unauthorized BYOK credentials", async () => {
  const { gateway } = await configure({ catalog: false });
  const metadata = {
    team_id: teamId,
    workspace_id: workspaceId,
    user_id: userId,
  };
  const byok = {
    model: "local-chat",
    messages,
    executionMode: "BYOK" as const,
    metadata,
  };
  await assert.rejects(
    gateway.chat.complete({ ...byok, byok: { provider: "local" } }),
    /API key|credential/i,
  );
  await assert.rejects(
    gateway.chat.complete({
      ...byok,
      byok: { provider: "local", apiKeyRef: "missing" },
    }),
    /API key|credential/i,
  );
  for (const entry of [
    {
      credentialAlias: "inactive",
      isActive: false,
      userId,
      apiKeyEncrypted: await encryptTeamSecret("inactive-user-key", teamId),
    },
    { credentialAlias: "empty", isActive: true, userId, apiKeyEncrypted: "" },
    {
      credentialAlias: "private-other-user",
      isActive: true,
      userId: randomUUID(),
      apiKeyEncrypted: await encryptTeamSecret("other-user-key", teamId),
    },
  ]) {
    await schema.db
      .insert(schema.modelGatewayByokCredentials)
      .values({
        id: randomUUID(),
        teamId,
        workspaceId,
        providerName: "local",
        providerKind: "openai-compatible",
        ...entry,
      });
    await assert.rejects(
      gateway.chat.complete({
        ...byok,
        byok: { provider: "local", apiKeyRef: entry.credentialAlias },
      }),
      /API key|credential/i,
    );
  }
  assert.deepEqual(requests, []);
});

test("an encrypted active BYOK key remains required and usable while the no-auth System Provider is disabled", async () => {
  const { gateway, routed } = await configure({ enabled: false });
  assert.equal(routed.providers.local!.globalReady, false);
  await schema.db
    .insert(schema.modelGatewayByokCredentials)
    .values({
      id: randomUUID(),
      teamId,
      workspaceId,
      userId,
      providerName: "local",
      providerKind: "openai-compatible",
      credentialAlias: "personal-local",
      apiKeyEncrypted: await encryptTeamSecret("actual-byok-user-key", teamId),
      isActive: true,
    });
  const result = await gateway.chat.complete({
    model: "local-chat",
    messages,
    executionMode: "BYOK",
    byok: { provider: "local", apiKeyRef: "personal-local" },
    metadata: { team_id: teamId, workspace_id: workspaceId, user_id: userId },
  });
  assert.equal(result.raw.content, "local reply");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.headers.authorization,
    "Bearer actual-byok-user-key",
  );
  assertNoAmbientCredentials();
  const before = await loadConfig(configPath);
  await schema.db
    .update(schema.modelGatewayByokCredentials)
    .set({ isActive: false })
    .where(eq(schema.modelGatewayByokCredentials.workspaceId, workspaceId));
  assert.equal(
    (await loadConfig(configPath))?.versionHash,
    before?.versionHash,
  );
});
