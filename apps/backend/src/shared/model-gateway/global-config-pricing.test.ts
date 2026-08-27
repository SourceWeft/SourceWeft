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

test("loadGlobalModelGatewayConfig folds an inline target into a one-element targets array", async () => {
  const loaded = await loadConfig(baseConfig());

  assert.deepEqual(loaded?.chatProfiles[0]?.targets, [
    {
      gatewaySlug: "test",
      providerName: "Test",
      targetModel: "test-chat",
      priority: 1,
      weight: 0,
    },
  ]);
});

test("parses deployment modelCapabilities rules (override layer)", async () => {
  const config = baseConfig();
  config.modelCapabilities = [
    {
      modelMatch: "deepseek-v4-pro",
      capabilities: {
        disabledParams: { tool_choice: null },
        toolCallArgumentJsonRepair: true,
        structuredOutputMethod: "function_calling",
      },
    },
  ];
  const loaded = await loadConfig(config);
  // Held as-is; the shipped DB is merged in at runtime, not here.
  assert.deepEqual(loaded?.modelCapabilities, [
    {
      modelMatch: "deepseek-v4-pro",
      capabilities: {
        disabledParams: { tool_choice: null },
        toolCallArgumentJsonRepair: true,
        structuredOutputMethod: "function_calling",
      },
    },
  ]);
});

test("modelCapabilities defaults to empty when the config omits it", async () => {
  const loaded = await loadConfig(baseConfig());
  assert.deepEqual(loaded?.modelCapabilities, []);
});

test("rejects a modelCapabilities entry missing capabilities", async () => {
  const config = baseConfig();
  config.modelCapabilities = [{ modelMatch: "x" }];
  await assert.rejects(loadConfig(config), /capabilities/);
});

test("loadGlobalModelGatewayConfig accepts multiple targets and orders them by priority", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "backup",
    baseUrl: "https://backup.test/v1",
    providerName: "Backup",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: true,
  });
  config.chatProfiles[0] = {
    profileAlias: "chat",
    modelAlias: "test-chat",
    isDefault: true,
    isActive: true,
    pricing: { litellmKey: "test-chat" },
    targets: [
      {
        gatewaySlug: "backup",
        providerName: "Backup",
        targetModel: "backup/test-chat",
        priority: 2,
      },
      {
        gatewaySlug: "test",
        providerName: "Test",
        targetModel: "test-chat",
        priority: 1,
      },
    ],
  };

  const loaded = await loadConfig(config);

  assert.deepEqual(
    loaded?.chatProfiles[0]?.targets.map((target) => target.targetModel),
    ["test-chat", "backup/test-chat"],
  );
});

test("loadGlobalModelGatewayConfig rejects mixing inline target fields with targets", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    ...config.chatProfiles[0],
    pricing: { litellmKey: "test-chat" },
    targets: [
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-chat" },
    ],
  };

  await assert.rejects(loadConfig(config), /both 'targets' and inline target fields/);
});

test("loadGlobalModelGatewayConfig rejects multiple targets without explicit pricing", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "backup",
    baseUrl: "https://backup.test/v1",
    providerName: "Backup",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: true,
  });
  config.chatProfiles[0] = {
    profileAlias: "chat",
    modelAlias: "test-chat",
    isDefault: true,
    isActive: true,
    targets: [
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-chat" },
      { gatewaySlug: "backup", providerName: "Backup", targetModel: "backup/test-chat" },
    ],
  };

  await assert.rejects(loadConfig(config), /must set an explicit 'pricing' block/);
});

test("loadGlobalModelGatewayConfig rejects a repeated target within one alias", async () => {
  const config = baseConfig();
  config.chatProfiles[0] = {
    profileAlias: "chat",
    modelAlias: "test-chat",
    isDefault: true,
    isActive: true,
    pricing: { litellmKey: "test-chat" },
    targets: [
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-chat" },
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-chat" },
    ],
  };

  await assert.rejects(loadConfig(config), /repeats target 'test\/test-chat'/);
});

test("loadGlobalModelGatewayConfig rejects multi-target embedding profiles", async () => {
  const config = baseConfig();
  config.embeddingProfiles[0] = {
    profileAlias: "embedding",
    modelAlias: "test-embedding",
    isDefault: true,
    isActive: true,
    targets: [
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-embedding" },
    ],
  };

  await assert.rejects(loadConfig(config), /must stay on a single model/);
});

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

test("isActiveEnv activates a dormant gateway when the env var is set", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "secondary",
    baseUrl: "https://secondary.test/v1",
    providerName: "Secondary",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: false,
    isActiveEnv: "SOURCEWEFT_TEST_ACTIVE_ENV",
  });
  process.env.SOURCEWEFT_TEST_ACTIVE_ENV = "sk-test";
  try {
    const loaded = await loadConfig(config);
    const secondary = loaded?.gateways.find((entry) => entry.slug === "secondary");
    assert.equal(secondary?.isActive, true);
    assert.equal(secondary?.isActiveEnv, "SOURCEWEFT_TEST_ACTIVE_ENV");
  } finally {
    delete process.env.SOURCEWEFT_TEST_ACTIVE_ENV;
  }
});

test("isActiveEnv leaves a dormant gateway inactive when the env var is unset", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "secondary",
    baseUrl: "https://secondary.test/v1",
    providerName: "Secondary",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: false,
    isActiveEnv: "SOURCEWEFT_TEST_ACTIVE_ENV_UNSET",
  });
  delete process.env.SOURCEWEFT_TEST_ACTIVE_ENV_UNSET;

  const loaded = await loadConfig(config);
  const secondary = loaded?.gateways.find((entry) => entry.slug === "secondary");

  assert.equal(secondary?.isActive, false);
  assert.equal(secondary?.isActiveEnv, "SOURCEWEFT_TEST_ACTIVE_ENV_UNSET");
});

test("explicit isActive:true wins even when isActiveEnv is set but unpopulated", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "secondary",
    baseUrl: "https://secondary.test/v1",
    providerName: "Secondary",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: true,
    isActiveEnv: "SOURCEWEFT_TEST_ACTIVE_ENV_EMPTY",
  });
  process.env.SOURCEWEFT_TEST_ACTIVE_ENV_EMPTY = "";
  try {
    const loaded = await loadConfig(config);
    const secondary = loaded?.gateways.find((entry) => entry.slug === "secondary");
    assert.equal(secondary?.isActive, true);
  } finally {
    delete process.env.SOURCEWEFT_TEST_ACTIVE_ENV_EMPTY;
  }
});

test("isActiveEnv activation changes the config version hash", async () => {
  const config = baseConfig();
  config.gateways.push({
    slug: "secondary",
    baseUrl: "https://secondary.test/v1",
    providerName: "Secondary",
    providerKind: "openai-compatible",
    supports: ["chat"],
    isDefault: false,
    isActive: false,
    isActiveEnv: "SOURCEWEFT_TEST_ACTIVE_HASH_ENV",
  });

  delete process.env.SOURCEWEFT_TEST_ACTIVE_HASH_ENV;
  const dormant = await loadConfig(config);

  process.env.SOURCEWEFT_TEST_ACTIVE_HASH_ENV = "sk-test";
  try {
    const active = await loadConfig(config);
    const dormantSecondary = dormant?.gateways.find(
      (entry) => entry.slug === "secondary",
    );
    const activeSecondary = active?.gateways.find(
      (entry) => entry.slug === "secondary",
    );
    assert.notEqual(dormant?.versionHash, active?.versionHash);
    assert.equal(dormantSecondary?.isActive, false);
    assert.equal(activeSecondary?.isActive, true);
  } finally {
    delete process.env.SOURCEWEFT_TEST_ACTIVE_HASH_ENV;
  }
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
          isActive: true,
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

test("default global config routes through OpenRouter with a dormant OrcaRouter gateway", async () => {
  const loaded = await loadGlobalModelGatewayConfig(
    resolve("config/model-gateway.global.json"),
  );
  const openRouterGateway = loaded?.gateways.find(
    (entry) => entry.slug === "openrouter-default",
  );
  const orcaRouterGateway = loaded?.gateways.find(
    (entry) => entry.slug === "orcarouter-default",
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
    ["openrouter-default", "orcarouter-default"],
  );
  // OrcaRouter ships alongside OpenRouter but dormant by default: it is an
  // openai-compatible provider with the richer catalog format. Setting
  // ORCAROUTER_API_KEY activates it via isActiveEnv (no config-file edit), so
  // the shipped default is active only when the key is present.
  assert.equal(orcaRouterGateway?.isActiveEnv, "ORCAROUTER_API_KEY");
  assert.equal(
    orcaRouterGateway?.isActive,
    Boolean(process.env.ORCAROUTER_API_KEY?.trim()),
  );
  assert.equal(orcaRouterGateway?.isDefault, false);
  assert.equal(orcaRouterGateway?.providerKind, "openai-compatible");
  assert.equal(orcaRouterGateway?.providerName, "orcarouter");
  assert.equal(orcaRouterGateway?.modelCatalog?.format, "orcarouter");
  assert.deepEqual(orcaRouterGateway?.modelCatalog?.kinds, [
    "chat",
    "vision",
    "embedding",
    "image",
    "tts",
  ]);
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
  // The shipped config writes targets inline; parsing folds each into a
  // one-element targets array. Capabilities are resolved at request time from
  // the model DB, not baked onto the target.
  assert.deepEqual(chatDefault?.targets, [
    {
      gatewaySlug: "openrouter-default",
      providerName: "openrouter",
      targetModel: "deepseek/deepseek-v4-pro",
      priority: 1,
      weight: 100,
    },
  ]);
  assert.equal(chatDefault?.providerRouting, undefined);
  assert.equal(ttsDefault?.targets[0]?.targetModel, "microsoft/mai-voice-2");
  assert.equal(ttsDefault?.targets[0]?.gatewaySlug, "openrouter-default");
  assert.equal(ttsDefault?.targets[0]?.providerName, "openrouter");
  assert.equal(embeddingDefault?.targets.length, 1);
  assert.equal(embeddingDefault?.targets[0]?.targetModel, "baai/bge-m3");
  assert.equal(embeddingDefault?.targets[0]?.gatewaySlug, "openrouter-default");
  assert.equal(embeddingDefault?.targets[0]?.providerName, "openrouter");
  assert.equal(embeddingDefault?.requestedDimensions, 1024);
});
