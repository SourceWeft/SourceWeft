import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadRouted: vi.fn(),
  createModelGateway: vi.fn(),
}));

// Only the configuration source and the model catalog's remote sources are
// replaced; the catalog registry, the builder, the endpoint policy, the
// capability rules and the SDK adapters behind them are the real ones tenant
// and BYOK calls use.
vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime")>()),
  loadRoutedGatewayConfig: mocks.loadRouted,
}));
// The configured model as models.dev lists it: "can reason" is a capability,
// which the catalog spells `reasoning_effort`.
vi.mock("./model-catalog/registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./model-catalog/registry")>();
  return {
    ...actual,
    modelCatalog: new actual.ModelCatalogRegistry({
      litellm: async () => [],
      modelsDev: async () => [
        {
          id: "deepseek/deepseek-v4.1-flash",
          provider: "openrouter",
          reasoning: true,
          reasoningEfforts: [],
          toolCall: true,
          structuredOutput: true,
          vision: false,
          // The price book for calls whose Provider reports no cost.
          pricing: { inputPerToken: 0.0000003, outputPerToken: 0.0000012 },
          sources: ["models.dev"],
        },
      ],
      overrides: () => new Map(),
    }),
  };
});
vi.mock("@sourceweft/model-gateway", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sourceweft/model-gateway")>();
  mocks.createModelGateway.mockImplementation(actual.createModelGateway);
  return { ...actual, createModelGateway: mocks.createModelGateway };
});

import { config } from "../config";
import { logger } from "../logger";
import { buildRoutedModelGatewayConfig } from "./runtime";
import { defaultTargetHealthRegistry } from "@sourceweft/model-gateway";
import {
  SYSTEM_MODEL_MAX_RETRIES,
  SYSTEM_MODEL_ROUTE,
  SYSTEM_MODEL_TIMEOUT_MS,
  SystemModelUnavailableError,
  buildSystemModelRoutedConfig,
  evaluateSystemModelReadiness,
  getSystemModelReadiness,
  resolveSystemModelIdentity,
  withSystemModel,
  type SystemModelPurpose,
  type SystemModelSettings,
} from "./system-client";
import type { RoutedGatewayConfig } from "./types";

const DEDICATED_KEY = "sk-dedicated-SECRET-7f3a";
const GLOBAL_KEY = "sk-global-SECRET-1c9d";
const MODEL = "deepseek/deepseek-v4.1-flash";
const BASE_URL = "https://openrouter.test/api/v1";

const originalSettings = { ...config.systemModel };

type Borrowed = RoutedGatewayConfig["providers"][string];

function borrowedProvider(overrides: Partial<Borrowed> = {}): Borrowed {
  return {
    gatewayConfigId: "gateway-openrouter",
    kind: "openrouter",
    baseUrl: BASE_URL,
    apiKey: GLOBAL_KEY,
    isBYOK: false,
    enabled: true,
    configured: true,
    globalReady: true,
    requiresGlobalApiKey: true,
    hasGlobalApiKey: true,
    defaultHeaders: { "X-Title": "SourceWeft" },
    supports: ["chat", "tool_calling", "json_schema"],
    timeoutMs: 30_000,
    maxRetries: 0,
    ...overrides,
  };
}

function routedFixture(
  provider: Partial<Borrowed> = {},
  versionId = randomUUID(),
): RoutedGatewayConfig {
  return {
    versionId,
    providers: {
      openrouter: borrowedProvider(provider),
      other: borrowedProvider({
        gatewayConfigId: "gateway-other",
        baseUrl: "https://other.test/v1",
        apiKey: "sk-other-SECRET",
      }),
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "other", model: "other-model", priority: 1 }],
      },
    },
  };
}

function settings(
  overrides: Partial<SystemModelSettings> = {},
): SystemModelSettings {
  return {
    enabled: true,
    provider: "openrouter",
    apiKey: DEDICATED_KEY,
    model: MODEL,
    ...overrides,
  };
}

function useSettings(overrides: Partial<SystemModelSettings> = {}) {
  Object.assign(config.systemModel, settings(overrides));
}

type SeenRequest = {
  url: string;
  authorization: string | null;
  title: string | null;
  body: Record<string, unknown>;
};

/** Answers every chat completion like OpenRouter does, recording what was sent. */
function mockProvider(
  answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({
    role: "assistant",
    content: "OUTPUT-MARKER",
  }),
  usageDetails: Record<string, unknown> = {},
) {
  const seen: SeenRequest[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const request = input as Request;
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      seen.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        title: request.headers.get("x-title"),
        body,
      });
      return new Response(
        JSON.stringify({
          id: "gen-system-test",
          object: "chat.completion",
          created: 1,
          model: MODEL,
          choices: [
            {
              index: 0,
              message: answer(body),
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            cost: 0.00042,
            ...usageDetails,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  return { seen, fetchSpy };
}

const context = (purpose: SystemModelPurpose = "skill_market.overview") => ({
  purpose,
  subjectRef: "skill-version:v1",
  scopeId: `scope-${randomUUID()}`,
});

const messages = [
  { role: "user" as const, content: "PROMPT-MARKER: describe this skill" },
];

function systemCallLogs(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([message]) => message === "system_model.call");
}

beforeEach(() => {
  mocks.loadRouted.mockReset();
  mocks.createModelGateway.mockClear();
  useSettings();
});

afterEach(() => {
  Object.assign(config.systemModel, originalSettings);
});

test("readiness covers every enabled/configured combination and names what is missing", () => {
  const routed = routedFixture();
  const cases: Array<{
    name: string;
    settings: SystemModelSettings;
    routed: RoutedGatewayConfig | null;
    enabled: boolean;
    configured: boolean;
    problems: string[];
    reason?: RegExp;
  }> = [
    {
      name: "enabled and configured",
      settings: settings(),
      routed,
      enabled: true,
      configured: true,
      problems: [],
    },
    {
      name: "disabled but configured",
      settings: settings({ enabled: false }),
      routed,
      enabled: false,
      configured: true,
      problems: ["disabled"],
      reason: /^SYSTEM_MODEL_ENABLED is not true$/,
    },
    {
      name: "enabled without a key",
      settings: settings({ apiKey: "" }),
      routed,
      enabled: true,
      configured: false,
      problems: ["api_key_unset"],
      reason: /^SYSTEM_MODEL_API_KEY is not set$/,
    },
    {
      name: "disabled and unconfigured",
      settings: settings({ enabled: false, apiKey: "", model: "" }),
      routed,
      enabled: false,
      configured: false,
      problems: ["disabled", "api_key_unset", "model_unset"],
      reason:
        /SYSTEM_MODEL_ENABLED is not true; SYSTEM_MODEL_API_KEY is not set; SYSTEM_MODEL_NAME is not set/,
    },
    {
      name: "no Provider named",
      settings: settings({ provider: "" }),
      routed,
      enabled: true,
      configured: false,
      problems: ["provider_unset"],
      reason: /SYSTEM_MODEL_PROVIDER is not set/,
    },
    {
      name: "unknown Provider",
      settings: settings({ provider: "atlascloud" }),
      routed,
      enabled: true,
      configured: false,
      problems: ["provider_not_found"],
      reason: /Provider 'atlascloud' is not in the active global/,
    },
    {
      name: "no synchronized gateway configuration",
      settings: settings(),
      routed: null,
      enabled: true,
      configured: false,
      problems: ["gateway_config_unavailable"],
      reason: /not synchronized/,
    },
    {
      name: "Provider without structured output",
      settings: settings(),
      routed: routedFixture({ supports: ["chat", "tool_calling"] }),
      enabled: true,
      configured: false,
      problems: ["provider_capability_missing"],
      reason: /does not declare support for json_schema$/,
    },
    {
      name: "Provider without chat",
      settings: settings(),
      routed: routedFixture({ supports: ["embeddings"] }),
      enabled: true,
      configured: false,
      problems: ["provider_capability_missing"],
      reason: /does not declare support for chat, json_schema$/,
    },
    {
      // A credential in the definition's headers is a global key by another
      // name: never borrowed, exactly as BYOK refuses it.
      name: "Provider with credential headers",
      settings: settings(),
      routed: routedFixture({
        defaultHeaders: { Authorization: `Bearer ${GLOBAL_KEY}` },
      }),
      enabled: true,
      configured: false,
      problems: ["provider_credential_headers"],
      reason: /Provider 'openrouter' sends credential headers of its own/,
    },
  ];
  for (const item of cases) {
    const readiness = evaluateSystemModelReadiness(item.settings, item.routed);
    assert.equal(readiness.enabled, item.enabled, item.name);
    assert.equal(readiness.configured, item.configured, item.name);
    assert.equal(readiness.ready, item.enabled && item.configured, item.name);
    assert.deepEqual(readiness.problems, item.problems, item.name);
    if (item.reason) assert.match(readiness.reason ?? "", item.reason);
    else assert.equal(readiness.reason, null, item.name);
    // Settings are named, values never.
    assert.doesNotMatch(JSON.stringify(readiness), /SECRET/);
  }
});

test("a Provider disabled or unkeyed for GLOBAL traffic still lends its definition", async () => {
  const routed = routedFixture({
    enabled: false,
    configured: false,
    globalReady: false,
    hasGlobalApiKey: false,
    apiKey: undefined,
  });
  mocks.loadRouted.mockResolvedValue(routed);
  const readiness = await getSystemModelReadiness();
  assert.equal(readiness.ready, true);

  const { seen } = mockProvider();
  const result = await withSystemModel(context(), (chat) =>
    chat.complete({ messages }),
  );
  assert.equal(result.raw.content, "OUTPUT-MARKER");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.authorization, `Bearer ${DEDICATED_KEY}`);
});

test("requests carry the dedicated key, never the Provider's global key", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const { seen } = mockProvider();
  await withSystemModel(context(), (chat) => chat.complete({ messages }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `${BASE_URL}/chat/completions`);
  assert.equal(seen[0]!.authorization, `Bearer ${DEDICATED_KEY}`);
  assert.equal(seen[0]!.body.model, MODEL);
  // The borrowed definition's non-secret headers ride along.
  assert.equal(seen[0]!.title, "SourceWeft");
});

test("an empty dedicated key is not ready and never falls back to the global key", async () => {
  useSettings({ apiKey: "" });
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const { fetchSpy } = mockProvider();
  const run = vi.fn();
  await assert.rejects(withSystemModel(context(), run), (error: unknown) => {
    assert.ok(error instanceof SystemModelUnavailableError);
    assert.equal(error.code, "SYSTEM_MODEL_NOT_READY");
    assert.deepEqual(error.readiness.problems, ["api_key_unset"]);
    assert.match(error.message, /SYSTEM_MODEL_API_KEY is not set/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  assert.equal(run.mock.calls.length, 0);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(mocks.createModelGateway.mock.calls.length, 0);

  // Disabled: the same, whatever else is configured.
  useSettings({ enabled: false });
  await assert.rejects(
    withSystemModel(context(), run),
    SystemModelUnavailableError,
  );
  assert.equal(fetchSpy.mock.calls.length, 0);
});

test("the in-memory configuration holds only the borrowed Provider and the system route", () => {
  const routed = routedFixture({
    enabled: false,
    globalReady: false,
  });
  const readiness = evaluateSystemModelReadiness(settings(), routed);
  const system = buildSystemModelRoutedConfig(routed, settings(), readiness);
  assert.deepEqual(Object.keys(system.providers), ["openrouter"]);
  assert.deepEqual(Object.keys(system.modelRoutes), [SYSTEM_MODEL_ROUTE]);
  const provider = system.providers.openrouter!;
  assert.equal(provider.apiKey, DEDICATED_KEY);
  assert.equal(provider.baseUrl, BASE_URL);
  // Enabled by our readiness, not the global activation it was copied from.
  assert.equal(provider.enabled, true);
  assert.equal(provider.globalReady, true);
  assert.equal(provider.timeoutMs, SYSTEM_MODEL_TIMEOUT_MS);
  assert.equal(provider.maxRetries, SYSTEM_MODEL_MAX_RETRIES);
  assert.deepEqual(system.modelRoutes[SYSTEM_MODEL_ROUTE]!.targets, [
    { provider: "openrouter", model: MODEL, priority: 1, weight: 100 },
  ]);
  // The loaded configuration is left as it was: the system route never joins
  // the tenant routing the user catalog is built from.
  assert.deepEqual(Object.keys(routed.providers), ["openrouter", "other"]);
  assert.deepEqual(Object.keys(routed.modelRoutes), ["chat-default"]);
  assert.equal(routed.providers.openrouter!.apiKey, GLOBAL_KEY);
  assert.equal(routed.providers.openrouter!.globalReady, false);

  const notReady = evaluateSystemModelReadiness(
    settings({ apiKey: "" }),
    routed,
  );
  assert.throws(
    () =>
      buildSystemModelRoutedConfig(routed, settings({ apiKey: "" }), notReady),
    SystemModelUnavailableError,
  );
});

test("the system gateway neither persists generations nor accepts BYOK credentials", () => {
  const routed = routedFixture();
  const readiness = evaluateSystemModelReadiness(settings(), routed);
  const built = buildRoutedModelGatewayConfig(
    buildSystemModelRoutedConfig(routed, settings(), readiness),
    { observeSink: null, byok: false },
  );
  assert.equal(built.observeSink, undefined);
  assert.equal(built.resolveApiKeyRef, undefined);
  assert.equal(built.resolveCustomByokProvider, undefined);
  assert.equal(built.providers?.openrouter?.byokEnabled, false);

  // Tenant calls keep the default: observed, BYOK-capable.
  const tenant = buildRoutedModelGatewayConfig(routed);
  assert.ok(tenant.observeSink);
  assert.ok(tenant.resolveApiKeyRef);
  assert.ok(tenant.resolveCustomByokProvider);
  assert.equal(tenant.providers?.openrouter?.byokEnabled, true);
});

test("capability rules shape the request exactly as they do for tenant calls", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const { seen } = mockProvider((body) => {
    const tools = body.tools as Array<{ function: { name: string } }>;
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: tools[0]!.function.name,
            arguments: JSON.stringify({ answer: "OUTPUT-MARKER" }),
          },
        },
      ],
    };
  });
  const result = await withSystemModel(context(), (chat) =>
    chat.complete({
      messages,
      structuredOutput: {
        name: "system_answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
      thinking: { mode: "off", enabled: false, includeReasoning: false },
      maxTokens: 256,
    }),
  );
  assert.deepEqual(result.structuredOutput, { answer: "OUTPUT-MARKER" });
  const body = seen[0]!.body;
  // DeepSeek: structured output rides as an available tool, never a forced
  // tool_choice and never a json_schema response_format (MODEL_CAPABILITY_DB).
  assert.ok(Array.isArray(body.tools));
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.response_format, undefined);
  // Thinking "off" reached the wire, from the model catalog's facts — the
  // source BYOK models use — not from a global profile of the Provider.
  assert.deepEqual(body.reasoning, { effort: "none", exclude: true });
});

test("a configured model the catalog does not list fails before any request", async () => {
  useSettings({ model: "vendor/unlisted-model" });
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const { fetchSpy } = mockProvider();
  const info = vi.spyOn(logger, "info");
  await assert.rejects(
    withSystemModel(context(), (chat) =>
      chat.complete({
        messages,
        thinking: { mode: "off", enabled: false, includeReasoning: false },
      }),
    ),
    (error: { code?: string; message?: string }) =>
      error.code === "CONFIGURATION" &&
      /'vendor\/unlisted-model' is not in the model catalog/.test(
        error.message ?? "",
      ),
  );
  assert.equal(fetchSpy.mock.calls.length, 0);
  const logs = systemCallLogs(info);
  assert.equal(logs.length, 1);
  assert.equal(
    (logs[0]![1] as Record<string, unknown>).errorCode,
    "CONFIGURATION",
  );
});

test("the endpoint policy rejects an internal address before any request", async () => {
  mocks.loadRouted.mockResolvedValue(
    routedFixture({ baseUrl: "http://169.254.169.254/v1" }),
  );
  const { fetchSpy } = mockProvider();
  await assert.rejects(
    withSystemModel(context(), (chat) => chat.complete({ messages })),
    /not allowed by deployment policy/,
  );
  assert.equal(fetchSpy.mock.calls.length, 0);
});

test("the endpoint policy refuses a redirect to an internal address", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const info = vi.spyOn(logger, "info");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 307,
      headers: { location: "http://10.0.0.1/v1/chat/completions" },
    }),
  );
  await assert.rejects(
    withSystemModel(context(), (chat) => chat.complete({ messages })),
    (error: { code?: string }) => error.code === "POLICY",
  );
  // Refused once; policy denials are not retried.
  assert.equal(fetchSpy.mock.calls.length, 1);
  const logs = systemCallLogs(info);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as Record<string, unknown>).errorCode, "POLICY");
});

test("each call logs exactly one line, without the prompt, the output or the key", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  mockProvider();
  const info = vi.spyOn(logger, "info");
  const warn = vi.spyOn(logger, "warn");
  const scope = context("mcp_market.overview");
  await withSystemModel(scope, async (chat) => {
    await chat.complete({ messages });
    await chat.complete({ messages });
  });
  const logs = systemCallLogs(info);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0]![1], {
    purpose: "mcp_market.overview",
    subjectRef: scope.subjectRef,
    scopeId: scope.scopeId,
    provider: "openrouter",
    model: MODEL,
    status: "ok",
    errorCode: null,
    durationMs: (logs[0]![1] as { durationMs: number }).durationMs,
    inputTokens: 11,
    outputTokens: 7,
    reasoningTokens: null,
    costUsd: 0.00042,
    costSource: "provider_actual",
  });
  const everything = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
  for (const secret of [
    "PROMPT-MARKER",
    "OUTPUT-MARKER",
    DEDICATED_KEY,
    GLOBAL_KEY,
  ]) {
    assert.doesNotMatch(everything, new RegExp(secret));
  }
});

test("the log line counts reasoning tokens when the Provider reports them", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  mockProvider(undefined, { completion_tokens_details: { reasoning_tokens: 5 } });
  const info = vi.spyOn(logger, "info");
  await withSystemModel(context(), (chat) => chat.complete({ messages }));
  const logs = systemCallLogs(info);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as Record<string, unknown>).reasoningTokens, 5);
});

test("a Provider that reports no cost is costed from the catalog's price book", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  mockProvider(undefined, { cost: undefined });
  const info = vi.spyOn(logger, "info");
  await withSystemModel(context(), (chat) => chat.complete({ messages }));
  const line = systemCallLogs(info)[0]![1] as Record<string, unknown>;
  // 11·0.0000003 + 7·0.0000012 = 0.0000033 + 0.0000084
  assert.equal(line.costUsd, 0.0000117);
  assert.equal(line.costSource, "price_book");
});

test("an OpenRouter BYOK call costs the fee plus the upstream charge, not $0", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  mockProvider(undefined, {
    is_byok: true,
    cost: 0,
    cost_details: { upstream_inference_cost: 0.0009 },
  });
  const info = vi.spyOn(logger, "info");
  await withSystemModel(context(), (chat) => chat.complete({ messages }));
  const line = systemCallLogs(info)[0]![1] as Record<string, unknown>;
  assert.equal(line.costUsd, 0.0009);
  assert.equal(line.costSource, "provider_actual");
});

test("an OpenRouter BYOK call without an upstream figure keeps the fee on top of the estimate", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  mockProvider(undefined, { is_byok: true, cost: 0.00001 });
  const info = vi.spyOn(logger, "info");
  await withSystemModel(context(), (chat) => chat.complete({ messages }));
  const line = systemCallLogs(info)[0]![1] as Record<string, unknown>;
  // 0.00001 fee + 0.0000117 estimate
  assert.equal(line.costUsd, 0.0000217);
  assert.equal(line.costSource, "price_book");
});

test("a failed call logs one error line and rethrows", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { message: "PROMPT-MARKER nope" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  const info = vi.spyOn(logger, "info");
  await assert.rejects(
    withSystemModel(context(), (chat) => chat.complete({ messages })),
    (error: { code?: string }) => error.code === "BAD_REQUEST",
  );
  const logs = systemCallLogs(info);
  assert.equal(logs.length, 1);
  const line = logs[0]![1] as Record<string, unknown>;
  assert.equal(line.status, "error");
  assert.equal(line.errorCode, "BAD_REQUEST");
  assert.equal(line.inputTokens, null);
  assert.equal("costUsd" in line, false);
  assert.doesNotMatch(JSON.stringify(logs), /PROMPT-MARKER/);
});

test("a failing dedicated key does not cool the target down for tenant calls", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ error: { message: "Insufficient credits" } }),
      {
        status: 402,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  await assert.rejects(
    withSystemModel(context(), (chat) => chat.complete({ messages })),
    (error: { code?: string }) => error.code === "QUOTA",
  );
  assert.equal(
    defaultTargetHealthRegistry.isCoolingDown({
      provider: "openrouter",
      baseUrl: BASE_URL,
      providerModel: MODEL,
    }),
    false,
  );
});

test("routing fields smuggled past the type cannot leave the system route", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  const { seen } = mockProvider();
  await withSystemModel(context(), (chat) =>
    chat.complete({
      messages,
      ...({
        model: "chat-default",
        profileAlias: "chat-default",
        providerHint: "other",
        executionMode: "BYOK",
        byok: { provider: "other", apiKey: "sk-smuggled" },
      } as object),
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `${BASE_URL}/chat/completions`);
  assert.equal(seen[0]!.authorization, `Bearer ${DEDICATED_KEY}`);
  assert.equal(seen[0]!.body.model, MODEL);
});

test("an unknown purpose is refused", async () => {
  mocks.loadRouted.mockResolvedValue(routedFixture());
  await assert.rejects(
    withSystemModel(
      { ...context(), purpose: "chat.title" as SystemModelPurpose },
      async () => undefined,
    ),
    /Unknown system model purpose/,
  );
});

test("the client is cached by configuration version, Provider and model, never by the key", async () => {
  const versionId = randomUUID();
  mocks.loadRouted.mockResolvedValue(routedFixture({}, versionId));
  mockProvider();
  const call = () =>
    withSystemModel(context(), (chat) => chat.complete({ messages }));
  await call();
  await call();
  assert.equal(mocks.createModelGateway.mock.calls.length, 1);
  useSettings({ apiKey: "sk-rotated-SECRET" });
  await call();
  assert.equal(mocks.createModelGateway.mock.calls.length, 1);
  useSettings({ model: "openai/gpt-5-mini" });
  await call();
  assert.equal(mocks.createModelGateway.mock.calls.length, 2);
  mocks.loadRouted.mockResolvedValue(routedFixture({}, randomUUID()));
  await call();
  assert.equal(mocks.createModelGateway.mock.calls.length, 3);
});

test("the model identity names the model and endpoint, never the credential", async () => {
  mocks.loadRouted.mockResolvedValue(
    routedFixture({
      baseUrl:
        "https://user:pass@openrouter.test/api/v1?api-version=2&key=SECRET",
    }),
  );
  const identity = await resolveSystemModelIdentity();
  assert.deepEqual(identity, {
    provider: "openrouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.test/api/v1",
    apiVersion: "2",
    model: MODEL,
  });
  // Switched off, still the same configured model.
  useSettings({ enabled: false });
  assert.deepEqual(await resolveSystemModelIdentity(), identity);
  useSettings({ apiKey: "" });
  assert.equal(await resolveSystemModelIdentity(), null);
});
