import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ChatOpenAICompletions } from "@langchain/openai";
import {
  createLangChainChatModel,
  createModelGateway,
  ModelGatewayError,
  resolveModelGatewayConfig,
  resolveRequestTarget,
  TargetHealthRegistry,
} from "../src/index";
import type { GatewayProviderConfig, ModelGatewayConfig } from "../src/types";
import { createJsonResponse, createSseResponse } from "./helpers";

function ambientCredentials(t: TestContext) {
  const values = {
    OPENAI_API_KEY: "ambient-api-key",
    OPENAI_ADMIN_KEY: "ambient-admin-key",
    OPENAI_ORGANIZATION: "ambient-langchain-org",
    OPENAI_ORG_ID: "ambient-sdk-org",
    OPENAI_PROJECT_ID: "ambient-project",
    OPENAI_CUSTOM_HEADERS:
      "Authorization: Bearer ambient-header-key\napi-key: ambient-api-header\nX-Api-Key: ambient-x-api-key\nX-Unrelated-Credential: ambient-custom-key",
    AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const ambient = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("An adapter bypassed the injected fetch");
  });
  t.after(() => assert.equal(ambient.mock.callCount(), 0));
}
function config(
  fetch: typeof globalThis.fetch,
  provider: Partial<GatewayProviderConfig> = {},
): ModelGatewayConfig {
  return {
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://local-model.internal:8000/v1",
        allowUnauthenticated: true,
        defaultHeaders: { "X-Instance": "declared-nonsecret" },
        ...provider,
      },
    },
    modelRoutes: {
      local: {
        strategy: "priority",
        targets: [{ provider: "local", model: "local-model", priority: 1 }],
      },
    },
    fetch,
    maxRetries: 0,
    targetHealth: new TargetHealthRegistry(),
  };
}
function assertNoCredentials(request: Request) {
  for (const name of [
    "authorization",
    "api-key",
    "x-api-key",
    "x-unrelated-credential",
    "openai-organization",
    "openai-project",
  ])
    assert.equal(request.headers.get(name), null, name);
  assert.equal(request.headers.get("x-instance"), "declared-nonsecret");
}
function chatResponse(body: { stream?: boolean; tools?: unknown[] }) {
  if (body.stream)
    return createSseResponse([
      `data: ${JSON.stringify({ id: "local-chat", object: "chat.completion.chunk", model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "local-ok" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "local-chat", object: "chat.completion.chunk", model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  return createJsonResponse({
    id: "local-chat",
    object: "chat.completion",
    model: "local-model",
    choices: [
      {
        index: 0,
        message: body.tools?.length
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"query":"local"}' },
                },
              ],
            }
          : { role: "assistant", content: "local-ok" },
        finish_reason: body.tools?.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

for (const operation of [
  "complete",
  "stream",
  "tools",
  "withConfig",
] as const) {
  test(`explicit no-auth System ${operation} uses the real SDK without any ambient credentials`, async (t) => {
    ambientCredentials(t);
    if (operation === "withConfig") {
      // Match the existing request-options transport tests: streaming invoke
      // estimates tokens after SSE and otherwise downloads tokenizer data.
      // This public seam isolates counting, while SDK/auth/HTTP stay real.
      t.mock.method(
        ChatOpenAICompletions.prototype,
        "getNumTokens",
        async () => 1,
      );
    }
    let requests = 0;
    const settings = config(async (input, init) => {
      const request = new Request(input, init);
      assertNoCredentials(request);
      requests++;
      const body = await request.json();
      if (operation === "tools")
        assert.equal(body.tools[0].function.name, "lookup");
      return chatResponse(body);
    });
    const gateway = createModelGateway(settings);
    const payload = {
      model: "local",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    if (operation === "stream") {
      const events = [];
      for await (const event of gateway.chat.stream(payload))
        events.push(event);
      assert.equal(events.at(-1)?.type, "metadata");
      assert.equal(
        events
          .filter((event) => event.type === "chunk")
          .map((event) => event.chunk.content)
          .join(""),
        "local-ok",
      );
    } else if (operation === "withConfig") {
      const model = await createLangChainChatModel({
        modelAlias: "local",
        config: settings,
      });
      const result = await model
        .withConfig({ tags: ["no-auth"] })
        .invoke("hello");
      assert.equal(result.content, "local-ok");
    } else {
      const result = await gateway.chat.complete({
        ...payload,
        ...(operation === "tools"
          ? {
              tools: [
                {
                  type: "function",
                  function: {
                    name: "lookup",
                    description: "lookup",
                    parameters: {
                      type: "object",
                      properties: { query: { type: "string" } },
                      required: ["query"],
                    },
                  },
                },
              ],
            }
          : {}),
      });
      if (operation === "tools")
        assert.deepEqual(result.raw.tool_calls?.[0]?.args, { query: "local" });
      else assert.equal(result.raw.content, "local-ok");
    }
    assert.equal(requests, 1);
  });
}

test("no-auth query and SDK-batched embeddings retain M10 usage capture and never create a dummy key", async (t) => {
  ambientCredentials(t);
  let calls = 0;
  const gateway = createModelGateway(
    config(async (input, init) => {
      const request = new Request(input, init);
      assertNoCredentials(request);
      const body = await request.json();
      const values = Array.isArray(body.input) ? body.input : [body.input];
      return createJsonResponse(
        {
          object: "list",
          model: "local-model",
          data: values.map((_value: string, index: number) => ({
            index,
            object: "embedding",
            embedding: [1, 0],
          })),
          usage: { prompt_tokens: 37, total_tokens: 37 },
        },
        { headers: { "x-request-id": `local-${++calls}` } },
      );
    }),
  );
  const single = await gateway.embeddings.embed({
    model: "local",
    text: "single",
  });
  const batch = await gateway.embeddings.embedBatch({
    model: "local",
    texts: Array.from({ length: 513 }, (_, index) => String(index)),
  });
  assert.equal(calls, 3);
  assert.equal(single.usage?.totalTokens, 37);
  assert.equal(batch.usage?.totalTokens, 74);
  assert.equal(batch.embeddings.length, 513);
  assert.equal(batch.observation?.identity.providerRequestId, undefined);
});

test("no-auth is an explicit GLOBAL opt-in; BYOK requires and sends only its own key", async (t) => {
  ambientCredentials(t);
  const requests: Request[] = [];
  const settings = config(
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      assert.equal(request.headers.get("authorization"), "Bearer user-key");
      assert.equal(request.headers.get("api-key"), null);
      assert.equal(request.headers.get("x-api-key"), null);
      assert.equal(request.headers.get("x-unrelated-credential"), null);
      return chatResponse(await request.json());
    },
    { enabled: false, byokEnabled: true },
  );
  const resolved = resolveModelGatewayConfig(settings);
  await assert.rejects(
    () =>
      resolveRequestTarget(resolved, {
        model: "local-model",
        executionMode: "BYOK",
        byok: { provider: "local" },
      }),
    (error: unknown) =>
      ModelGatewayError.isInstance(error) && error.code === "AUTH",
  );
  const target = await resolveRequestTarget(resolved, {
    model: "local-model",
    executionMode: "BYOK",
    byok: { provider: "local", apiKey: "user-key" },
  });
  assert.equal(target.allowUnauthenticated, undefined);
  const result = await createModelGateway(settings).chat.complete({
    model: "local-model",
    messages: [],
    executionMode: "BYOK",
    byok: { provider: "local", apiKey: "user-key" },
  });
  assert.equal(result.raw.content, "local-ok");
  assert.equal(requests.length, 1);
});

test("missing keys without the explicit flag remain POLICY, even with ambient credentials", async (t) => {
  ambientCredentials(t);
  const gateway = createModelGateway(
    config(
      async () => {
        throw new Error("No request may be sent");
      },
      { allowUnauthenticated: false },
    ),
  );
  const isPolicy = (error: unknown) =>
    ModelGatewayError.isInstance(error) && error.code === "POLICY";
  await assert.rejects(
    () => gateway.chat.complete({ model: "local", messages: [] }),
    isPolicy,
  );
  await assert.rejects(
    () => gateway.embeddings.embed({ model: "local", text: "hello" }),
    isPolicy,
  );
});

test("no-auth rejects vendor adapters and explicit credential conflicts at configuration loading", () => {
  for (const kind of [
    "openai",
    "openrouter",
    "deepinfra",
    "siliconflow-cn",
    "azure-openai",
    "gemini",
    "anthropic",
    "deepseek",
    "cloudflare-aig",
  ]) {
    assert.throws(
      () => resolveModelGatewayConfig(config(globalThis.fetch, { kind })),
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.code === "POLICY",
    );
  }
  const conflicts: Partial<GatewayProviderConfig>[] = [
    { apiKey: "explicit-key" },
    { apiKeyHeaderName: "X-Custom-Key" },
    { defaultHeaders: { aUtHoRiZaTiOn: "Bearer explicit" } },
    { defaultHeaders: { "API-Key": "explicit" } },
    { defaultHeaders: { "X-API-KEY": "explicit" } },
    { defaultHeaders: { Cookie: "session=explicit" } },
    { defaultHeaders: { "Proxy-Authorization": "Basic explicit" } },
    { allowUnauthenticated: "true" as unknown as boolean },
  ];
  for (const provider of conflicts)
    assert.throws(
      () => resolveModelGatewayConfig(config(globalThis.fetch, provider)),
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.code === "POLICY",
    );
});

test("no-auth survives the GLOBAL default provider route without enabling a disabled provider", async () => {
  const settings = config(globalThis.fetch);
  settings.providers = { default: settings.providers!.local! };
  settings.modelRoutes = undefined;
  settings.allowNonDefaultAliases = true;
  const resolved = resolveModelGatewayConfig(settings);
  assert.equal(
    (await resolveRequestTarget(resolved, { model: "arbitrary-local-model" }))
      .allowUnauthenticated,
    true,
  );
  settings.providers.default!.enabled = false;
  await assert.rejects(
    () =>
      resolveRequestTarget(resolveModelGatewayConfig(settings), {
        model: "arbitrary-local-model",
      }),
    (error: unknown) =>
      ModelGatewayError.isInstance(error) && error.code === "CONFIGURATION",
  );
});

for (const kind of [
  "openai-compatible",
  "openai",
  "openrouter",
  "deepinfra",
  "deepseek",
  "cloudflare-aig",
  "siliconflow-cn",
  "azure-openai",
] as const) {
  test(`${kind} real chat SDK ignores ambient custom auth headers while preserving explicit credentials`, async (t) => {
    ambientCredentials(t);
    let calls = 0;
    const settings = config(
      async (input, init) => {
        const request = new Request(input, init);
        calls++;
        if (kind === "azure-openai")
          assert.equal(request.headers.get("api-key"), "explicit-key");
        else
          assert.equal(
            request.headers.get("authorization"),
            "Bearer explicit-key",
          );
        assert.equal(request.headers.get("x-api-key"), null);
        assert.equal(request.headers.get("x-unrelated-credential"), null);
        return chatResponse(await request.json());
      },
      { kind, allowUnauthenticated: false, apiKey: "explicit-key" },
    );
    await createModelGateway(settings).chat.complete({
      model: "local",
      messages: [],
    });
    assert.equal(calls, 1);
  });
}

for (const kind of [
  "openai-compatible",
  "openai",
  "openrouter",
  "deepinfra",
  "siliconflow-cn",
  "azure-openai",
] as const) {
  test(`${kind} real embedding SDK ignores ambient custom auth headers`, async (t) => {
    ambientCredentials(t);
    let calls = 0;
    const settings = config(
      async (input, init) => {
        const request = new Request(input, init);
        calls++;
        if (kind === "azure-openai")
          assert.equal(request.headers.get("api-key"), "embedding-user-key");
        else
          assert.equal(
            request.headers.get("authorization"),
            "Bearer embedding-user-key",
          );
        assert.equal(request.headers.get("x-api-key"), null);
        assert.equal(request.headers.get("x-unrelated-credential"), null);
        return createJsonResponse({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 37, total_tokens: 37 },
        });
      },
      { kind, allowUnauthenticated: false, apiKey: "embedding-user-key" },
    );
    const result = await createModelGateway(settings).embeddings.embed({
      model: "local",
      text: "hello",
    });
    assert.equal(result.usage?.totalTokens, 37);
    assert.equal(calls, 1);
  });
}

test("BYOK cannot inherit System credential headers; an inline endpoint supplies independent headers", async () => {
  for (const [header, apiKeyHeaderName] of [
    ["aUtHoRiZaTiOn", undefined],
    ["API-Key", undefined],
    ["X-API-KEY", undefined],
    ["COOKIE", undefined],
    ["Proxy-Authorization", undefined],
    ["x-custom-key", "X-Custom-Key"],
  ] as const) {
    let calls = 0;
    const settings = config(
      async (input, init) => {
        const request = new Request(input, init);
        calls++;
        assert.equal(request.headers.get("authorization"), "Bearer user-key");
        assert.equal(request.headers.get("api-key"), null);
        assert.equal(request.headers.get("x-custom-key"), null);
        return chatResponse(await request.json());
      },
      {
        allowUnauthenticated: false,
        apiKey: "global-key",
        apiKeyHeaderName,
        defaultHeaders: { [header]: "global-header-secret" },
      },
    );
    const resolved = resolveModelGatewayConfig(settings);
    const global = await resolveRequestTarget(resolved, { model: "local" });
    assert.equal(global.defaultHeaders[header], "global-header-secret");
    const gateway = createModelGateway(settings);
    for (const apiKey of [undefined, "user-key"]) {
      await assert.rejects(
        () =>
          gateway.chat.complete({
            model: "local-model",
            executionMode: "BYOK",
            byok: { provider: "local", apiKey },
            messages: [],
          }),
        (error: unknown) =>
          ModelGatewayError.isInstance(error) && error.code === "POLICY",
      );
    }
    assert.equal(calls, 0);
    await gateway.chat.complete({
      model: "local-model",
      executionMode: "BYOK",
      byok: {
        provider: "local",
        apiKey: "user-key",
        baseUrl: "https://user-endpoint.invalid/v1",
      },
      messages: [],
    });
    assert.equal(calls, 1);
  }
});

test("authenticated GLOBAL requests retain explicitly declared headers while ignoring SDK environment headers", async (t) => {
  ambientCredentials(t);
  const settings = config(
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(
        request.headers.get("authorization"),
        "Bearer explicit-global-header",
      );
      assert.equal(request.headers.get("x-instance"), "declared");
      assert.equal(request.headers.get("x-unrelated-credential"), null);
      return chatResponse(await request.json());
    },
    {
      allowUnauthenticated: false,
      apiKey: "explicit-key",
      defaultHeaders: {
        Authorization: "Bearer explicit-global-header",
        "X-Instance": "declared",
      },
    },
  );
  await createModelGateway(settings).chat.complete({
    model: "local",
    messages: [],
  });
});

test("no-auth transport policy refusals still stop SDK retry and GLOBAL provider failover", async () => {
  let calls = 0;
  const refusal = new ModelGatewayError({
    code: "POLICY",
    message: "Endpoint denied",
    retryable: false,
  });
  const settings = config(async () => {
    calls++;
    throw refusal;
  });
  settings.maxRetries = 2;
  settings.providers!.backup = {
    kind: "openai-compatible",
    baseUrl: "http://backup.internal/v1",
    allowUnauthenticated: true,
  };
  settings.modelRoutes!.local!.targets.push({
    provider: "backup",
    model: "backup",
    priority: 2,
  });
  await assert.rejects(
    () =>
      createModelGateway(settings).chat.complete({
        model: "local",
        messages: [],
      }),
    (error) => error === refusal,
  );
  assert.equal(calls, 1);
});
