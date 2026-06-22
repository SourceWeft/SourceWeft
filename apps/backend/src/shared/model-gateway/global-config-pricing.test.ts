import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { loadGlobalModelGatewayConfig } from "./global-config";

function baseConfig(): Record<string, unknown> & {
  chatProfiles: Array<Record<string, unknown>>;
  embeddingProfiles: Array<Record<string, unknown>>;
  gateways: Array<Record<string, unknown>>;
  rerankProfiles?: Array<Record<string, unknown>>;
} {
  return {
    gateways: [
      {
        slug: "test",
        baseUrl: "https://example.test/v1",
        providerName: "Test",
        providerKind: "openai-compatible",
        supports: ["chat", "rerank", "embedding"],
        isDefault: true,
        isActive: true,
      },
    ],
    chatProfiles: [
      {
        profileAlias: "chat",
        modelAlias: "test-chat",
        gatewaySlug: "test",
        providerName: "Test",
        isDefault: true,
        isActive: true,
      },
    ],
    rerankProfiles: [
      {
        profileAlias: "rerank",
        modelAlias: "test-rerank",
        gatewaySlug: "test",
        providerName: "Test",
        isDefault: true,
        isActive: true,
      },
    ],
    embeddingProfiles: [
      {
        profileAlias: "embedding",
        modelAlias: "test-embedding",
        gatewaySlug: "test",
        providerName: "Test",
        isDefault: true,
        isActive: true,
      },
    ],
  };
}

async function loadConfig(config: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "sourceweft-global-config-"));
  const configPath = join(dir, "model-gateway.global.json");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  try {
    return await loadGlobalModelGatewayConfig(configPath);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("loadGlobalModelGatewayConfig preserves omitted pricing as undefined", async () => {
  const loaded = await loadConfig(baseConfig());

  assert.equal(loaded?.chatProfiles[0]?.pricing, undefined);
});

test("loadGlobalModelGatewayConfig preserves custom API key header config", async () => {
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    apiKeyEnv: "CF_AIG_TOKEN",
    apiKeyHeaderName: "cf-aig-authorization",
    apiKeyHeaderPrefix: "Bearer ",
  };

  const loaded = await loadConfig(config);

  assert.equal(loaded?.gateways[0]?.apiKeyEnv, "CF_AIG_TOKEN");
  assert.equal(loaded?.gateways[0]?.apiKeyHeaderName, "cf-aig-authorization");
  assert.equal(loaded?.gateways[0]?.apiKeyHeaderPrefix, "Bearer ");
});

test("loadGlobalModelGatewayConfig preserves explicit null pricing", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    pricing: null,
  };

  const loaded = await loadConfig(config);

  assert.equal(loaded?.chatProfiles[0]?.pricing, null);
});

test("loadGlobalModelGatewayConfig preserves litellm pricing presets", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    pricing: {
      litellmKey: "openai/gpt-test",
    },
  };

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.chatProfiles[0]?.pricing, {
    cacheCreationInputTokenCost: undefined,
    cacheReadInputTokenCost: undefined,
    inputCostPerAudioToken: undefined,
    inputCostPerImage: undefined,
    inputCostPerImageToken: undefined,
    inputCostPerToken: undefined,
    litellmKey: "openai/gpt-test",
    outputCostPerAudioToken: undefined,
    outputCostPerImage: undefined,
    outputCostPerImageToken: undefined,
    outputCostPerReasoningToken: undefined,
    outputCostPerToken: undefined,
  });
});

test("loadGlobalModelGatewayConfig accepts provider routing only", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    providerRouting: {
      only: ["deepseek"],
    },
  };

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.chatProfiles[0]?.providerRouting, {
    only: ["deepseek"],
  });
});

test("loadGlobalModelGatewayConfig accepts provider routing string sort", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    providerRouting: {
      sort: "latency",
    },
  };

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.chatProfiles[0]?.providerRouting, {
    sort: "latency",
  });
});

test("loadGlobalModelGatewayConfig accepts provider routing object sort", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    providerRouting: {
      sort: {
        by: "throughput",
        partition: "none",
      },
    },
  };

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.chatProfiles[0]?.providerRouting, {
    sort: {
      by: "throughput",
      partition: "none",
    },
  });
});

test("loadGlobalModelGatewayConfig rejects invalid provider routing", async () => {
  for (const providerRouting of [
    { only: [] },
    { only: [""] },
    { only: "deepseek" },
    { sort: "quality" },
    { sort: { by: "quality", partition: "none" } },
    { sort: { by: "latency", partition: "region" } },
  ]) {
    const config = baseConfig();
    config.chatProfiles[0] = {
      ...config.chatProfiles[0],
      providerRouting,
    };

    await assert.rejects(
      () => loadConfig(config),
      /providerRouting/,
      `expected providerRouting ${JSON.stringify(providerRouting)} to be rejected`,
    );
  }
});

test("loadGlobalModelGatewayConfig allows missing provider API key env", async () => {
  const config = baseConfig();
  config.gateways = [
    {
      ...(config.gateways[0] as Record<string, unknown>),
      apiKeyEnv: "SOURCEWEFT_TEST_MISSING_PROVIDER_KEY",
    },
  ];
  const original = process.env.SOURCEWEFT_TEST_MISSING_PROVIDER_KEY;
  delete process.env.SOURCEWEFT_TEST_MISSING_PROVIDER_KEY;

  try {
    const loaded = await loadConfig(config);

    assert.equal(loaded?.gateways[0]?.apiKey, undefined);
    assert.equal(
      loaded?.gateways[0]?.apiKeyEnv,
      "SOURCEWEFT_TEST_MISSING_PROVIDER_KEY",
    );
  } finally {
    if (original === undefined) {
      delete process.env.SOURCEWEFT_TEST_MISSING_PROVIDER_KEY;
    } else {
      process.env.SOURCEWEFT_TEST_MISSING_PROVIDER_KEY = original;
    }
  }
});

test("loadGlobalModelGatewayConfig resolves provider base URL env override", async () => {
  const config = baseConfig();
  config.gateways = [
    {
      ...(config.gateways[0] as Record<string, unknown>),
      baseUrl: "https://api.deepinfra.com/v1",
      baseUrlEnv: "SOURCEWEFT_TEST_DEEPINFRA_API_BASE",
      providerKind: "deepinfra",
      providerName: "deepinfra",
    },
  ];
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    providerName: "deepinfra",
  };
  config.embeddingProfiles[0] = {
    ...config.embeddingProfiles[0],
    providerName: "deepinfra",
  };
  config.rerankProfiles![0] = {
    ...config.rerankProfiles![0],
    providerName: "deepinfra",
  };
  const original = process.env.SOURCEWEFT_TEST_DEEPINFRA_API_BASE;
  process.env.SOURCEWEFT_TEST_DEEPINFRA_API_BASE =
    "https://proxy.example.com/deepinfra///";

  try {
    const loaded = await loadConfig(config);

    assert.equal(
      loaded?.gateways[0]?.baseUrl,
      "https://proxy.example.com/deepinfra",
    );
    assert.equal(
      loaded?.gateways[0]?.baseUrlEnv,
      "SOURCEWEFT_TEST_DEEPINFRA_API_BASE",
    );
    assert.deepEqual(
      loaded?.sourceJson._resolvedGatewayBaseUrls,
      [
        {
          baseUrl: "https://proxy.example.com/deepinfra",
          baseUrlEnv: "SOURCEWEFT_TEST_DEEPINFRA_API_BASE",
          slug: "test",
        },
      ],
    );
  } finally {
    if (original === undefined) {
      delete process.env.SOURCEWEFT_TEST_DEEPINFRA_API_BASE;
    } else {
      process.env.SOURCEWEFT_TEST_DEEPINFRA_API_BASE = original;
    }
  }
});

test("loadGlobalModelGatewayConfig falls back to static base URL when env is empty", async () => {
  const config = baseConfig();
  config.gateways = [
    {
      ...(config.gateways[0] as Record<string, unknown>),
      baseUrlEnv: "SOURCEWEFT_TEST_EMPTY_API_BASE",
    },
  ];
  const original = process.env.SOURCEWEFT_TEST_EMPTY_API_BASE;
  process.env.SOURCEWEFT_TEST_EMPTY_API_BASE = "   ";

  try {
    const loaded = await loadConfig(config);

    assert.equal(loaded?.gateways[0]?.baseUrl, "https://example.test/v1");
  } finally {
    if (original === undefined) {
      delete process.env.SOURCEWEFT_TEST_EMPTY_API_BASE;
    } else {
      process.env.SOURCEWEFT_TEST_EMPTY_API_BASE = original;
    }
  }
});

test("loadGlobalModelGatewayConfig rejects invalid base URL env override", async () => {
  const config = baseConfig();
  config.gateways = [
    {
      ...(config.gateways[0] as Record<string, unknown>),
      baseUrlEnv: "SOURCEWEFT_TEST_INVALID_API_BASE",
    },
  ];
  const original = process.env.SOURCEWEFT_TEST_INVALID_API_BASE;
  process.env.SOURCEWEFT_TEST_INVALID_API_BASE = "not-a-url";

  try {
    await assert.rejects(
      () => loadConfig(config),
      /gateways\[0\]\.baseUrlEnv:SOURCEWEFT_TEST_INVALID_API_BASE/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.SOURCEWEFT_TEST_INVALID_API_BASE;
    } else {
      process.env.SOURCEWEFT_TEST_INVALID_API_BASE = original;
    }
  }
});

test("loadGlobalModelGatewayConfig version hash changes with base URL env override", async () => {
  const config = baseConfig();
  config.gateways = [
    {
      ...(config.gateways[0] as Record<string, unknown>),
      baseUrlEnv: "SOURCEWEFT_TEST_HASH_API_BASE",
    },
  ];
  const original = process.env.SOURCEWEFT_TEST_HASH_API_BASE;

  try {
    process.env.SOURCEWEFT_TEST_HASH_API_BASE = "https://gateway-one.example.com/v1";
    const first = await loadConfig(config);
    process.env.SOURCEWEFT_TEST_HASH_API_BASE = "https://gateway-two.example.com/v1";
    const second = await loadConfig(config);

    assert.notEqual(first?.versionHash, second?.versionHash);
  } finally {
    if (original === undefined) {
      delete process.env.SOURCEWEFT_TEST_HASH_API_BASE;
    } else {
      process.env.SOURCEWEFT_TEST_HASH_API_BASE = original;
    }
  }
});

test("loadGlobalModelGatewayConfig allows omitted rerank profiles", async () => {
  const config = baseConfig();
  delete config.rerankProfiles;

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.rerankProfiles, []);
});

test("default global config is OpenRouter-only with OSS default models", async () => {
  const loaded = await loadGlobalModelGatewayConfig(
    resolve("config/model-gateway.global.json"),
  );
  const openRouterGateway = loaded?.gateways.find(
    (entry) => entry.slug === "openrouter-default",
  );
  const chatDefault = loaded?.chatProfiles.find(
    (entry) => entry.profileAlias === "chat-default",
  );
  const ttsDefault = loaded?.ttsProfiles.find(
    (entry) => entry.profileAlias === "tts-default",
  );
  const embeddingDefault = loaded?.embeddingProfiles.find(
    (entry) => entry.profileAlias === "embed-default",
  );

  assert.deepEqual(
    loaded?.gateways.map((entry) => entry.slug),
    ["openrouter-default"],
  );
  assert.deepEqual(openRouterGateway?.defaultHeaders, {
    "X-OpenRouter-Title": "SourceWeft",
    "X-Title": "SourceWeft",
    "HTTP-Referer": "https://sourceweft.com",
  });
  assert.equal(openRouterGateway?.baseUrlEnv, "OPENROUTER_API_BASE");
  assert.deepEqual(openRouterGateway?.supports, [
    "chat",
    "embeddings",
    "rerank",
    "tts",
    "image",
    "tool_calling",
    "json_schema",
  ]);
  assert.deepEqual(openRouterGateway?.modelCatalog?.kinds, [
    "chat",
    "vision",
    "image",
  ]);
  assert.deepEqual(loaded?.rerankProfiles, []);
  assert.deepEqual(loaded?.asrProfiles, []);
  assert.equal(chatDefault?.targetModel, "deepseek/deepseek-v4-pro");
  assert.equal(chatDefault?.providerRouting, undefined);
  assert.equal(ttsDefault?.targetModel, "microsoft/mai-voice-2");
  assert.equal(ttsDefault?.gatewaySlug, "openrouter-default");
  assert.equal(ttsDefault?.providerName, "openrouter");
  assert.equal(embeddingDefault?.targetModel, "baai/bge-m3");
  assert.equal(embeddingDefault?.gatewaySlug, "openrouter-default");
  assert.equal(embeddingDefault?.providerName, "openrouter");
  assert.equal(embeddingDefault?.requestedDimensions, 1024);
});
