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
        activation: {
          env: "SOURCEWEFT_TEST_GATEWAY_ENABLED",
          default: true,
        },
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
    activation: {
      env: "SOURCEWEFT_TEST_BACKUP_ENABLED",
      default: true,
    },
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

  await assert.rejects(
    loadConfig(config),
    /both 'targets' and inline target fields/,
  );
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
    activation: {
      env: "SOURCEWEFT_TEST_BACKUP_ENABLED",
      default: true,
    },
  });
  config.chatProfiles[0] = {
    profileAlias: "chat",
    modelAlias: "test-chat",
    isDefault: true,
    isActive: true,
    targets: [
      { gatewaySlug: "test", providerName: "Test", targetModel: "test-chat" },
      {
        gatewaySlug: "backup",
        providerName: "Backup",
        targetModel: "backup/test-chat",
      },
    ],
  };

  await assert.rejects(
    loadConfig(config),
    /must set an explicit 'pricing' block/,
  );
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
      {
        gatewaySlug: "test",
        providerName: "Test",
        targetModel: "test-embedding",
      },
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
    assert.deepEqual(loaded?.gateways[0]?.activation, {
      env: "SOURCEWEFT_TEST_GATEWAY_ENABLED",
      source: "default",
      enabled: true,
      configured: false,
      globalReady: false,
    });
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

test("gateway activation env strictly overrides its default without consulting the API key", async () => {
  const envName = "SOURCEWEFT_TEST_ACTIVATION_OVERRIDE";
  const original = process.env[envName];
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    activation: { env: envName, default: false },
    apiKeyEnv: "SOURCEWEFT_TEST_ACTIVATION_KEY",
  };
  process.env[envName] = "  TrUe  ";
  delete process.env.SOURCEWEFT_TEST_ACTIVATION_KEY;
  try {
    const loaded = await loadConfig(config);
    assert.deepEqual(loaded?.gateways[0]?.activation, {
      env: envName,
      source: "env",
      enabled: true,
      configured: false,
      globalReady: false,
    });
  } finally {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  }
});

test("gateway API key does not activate a disabled gateway", async () => {
  const keyName = "SOURCEWEFT_TEST_DISABLED_GATEWAY_KEY";
  const original = process.env[keyName];
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    activation: {
      env: "SOURCEWEFT_TEST_DISABLED_GATEWAY_ENABLED",
      default: false,
    },
    apiKeyEnv: keyName,
  };
  process.env[keyName] = "secret-not-hashed";
  try {
    const loaded = await loadConfig(config);
    assert.equal(loaded?.gateways[0]?.activation.enabled, false);
    assert.equal(loaded?.gateways[0]?.activation.configured, true);
    assert.equal(loaded?.gateways[0]?.activation.globalReady, false);
  } finally {
    if (original === undefined) delete process.env[keyName];
    else process.env[keyName] = original;
  }
});

test("gateway activation rejects invalid boolean env values", async () => {
  const envName = "SOURCEWEFT_TEST_INVALID_ACTIVATION";
  const original = process.env[envName];
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    activation: { env: envName, default: true },
  };
  process.env[envName] = "yes";
  try {
    await assert.rejects(() => loadConfig(config), new RegExp(envName));
  } finally {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  }
});

test("gateway activation rejects the obsolete raw isActive field", async () => {
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    isActive: true,
  };
  await assert.rejects(() => loadConfig(config), /isActive; use activation/);
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
    assert.deepEqual(loaded?.sourceJson._resolvedGateways, [
      {
        baseUrl: "https://proxy.example.com/deepinfra",
        baseUrlEnv: "SOURCEWEFT_TEST_DEEPINFRA_API_BASE",
        activation: {
          configured: true,
          enabled: true,
          env: "SOURCEWEFT_TEST_GATEWAY_ENABLED",
          globalReady: true,
          source: "default",
        },
        slug: "test",
      },
    ]);
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
    process.env.SOURCEWEFT_TEST_HASH_API_BASE =
      "https://gateway-one.example.com/v1";
    const first = await loadConfig(config);
    process.env.SOURCEWEFT_TEST_HASH_API_BASE =
      "https://gateway-two.example.com/v1";
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

test("gateway activation and credential presence change the safe config hash", async () => {
  const enabledEnv = "SOURCEWEFT_TEST_HASH_ENABLED";
  const keyEnv = "SOURCEWEFT_TEST_HASH_KEY";
  const originalEnabled = process.env[enabledEnv];
  const originalKey = process.env[keyEnv];
  const config = baseConfig();
  config.gateways[0] = {
    ...config.gateways[0],
    activation: { env: enabledEnv, default: false },
    apiKeyEnv: keyEnv,
  };

  try {
    process.env[enabledEnv] = "false";
    delete process.env[keyEnv];
    const disabled = await loadConfig(config);

    process.env[enabledEnv] = "true";
    const enabledWithoutKey = await loadConfig(config);

    process.env[keyEnv] = "first-secret";
    const readyWithFirstKey = await loadConfig(config);

    process.env[keyEnv] = "rotated-secret";
    const readyWithRotatedKey = await loadConfig(config);

    assert.notEqual(disabled?.versionHash, enabledWithoutKey?.versionHash);
    assert.notEqual(
      enabledWithoutKey?.versionHash,
      readyWithFirstKey?.versionHash,
    );
    assert.equal(
      readyWithFirstKey?.versionHash,
      readyWithRotatedKey?.versionHash,
    );
    assert.equal(
      JSON.stringify(readyWithFirstKey?.sourceJson).includes("first-secret"),
      false,
    );
  } finally {
    if (originalEnabled === undefined) delete process.env[enabledEnv];
    else process.env[enabledEnv] = originalEnabled;
    if (originalKey === undefined) delete process.env[keyEnv];
    else process.env[keyEnv] = originalKey;
  }
});

test("BYOK network permission does not change global activation or its config hash", async () => {
  const previous = process.env.LLM_ALLOWED_INTERNAL_ORIGINS;
  try {
    const input = baseConfig();
    process.env.LLM_ALLOWED_INTERNAL_ORIGINS = "[]";
    const first = await loadConfig(input);
    process.env.LLM_ALLOWED_INTERNAL_ORIGINS = '["http://127.0.0.1:11434"]';
    const second = await loadConfig(input);
    assert.equal(first?.versionHash, second?.versionHash);
    assert.deepEqual(first?.gateways, second?.gateways);
  } finally {
    if (previous === undefined) delete process.env.LLM_ALLOWED_INTERNAL_ORIGINS;
    else process.env.LLM_ALLOWED_INTERNAL_ORIGINS = previous;
  }
});

test("loadGlobalModelGatewayConfig allows omitted rerank profiles", async () => {
  const config = baseConfig();
  delete config.rerankProfiles;

  const loaded = await loadConfig(config);

  assert.deepEqual(loaded?.rerankProfiles, []);
});

test("default global config routes through OpenRouter with a dormant OrcaRouter gateway", async () => {
  const names = [
    "OPENROUTER_ENABLED",
    "OPENROUTER_API_KEY",
    "ORCAROUTER_ENABLED",
    "ORCAROUTER_API_KEY",
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  let loaded: Awaited<ReturnType<typeof loadGlobalModelGatewayConfig>>;
  try {
    loaded = await loadGlobalModelGatewayConfig(
      resolve("config/model-gateway.global.json"),
    );
  } finally {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  // OrcaRouter ships disabled and its credential never changes activation.
  assert.equal(orcaRouterGateway?.activation.enabled, false);
  assert.equal(orcaRouterGateway?.activation.globalReady, false);
  assert.equal(orcaRouterGateway?.activation.env, "ORCAROUTER_ENABLED");
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
  assert.equal(openRouterGateway?.activation.enabled, true);
  assert.equal(openRouterGateway?.activation.configured, false);
  assert.equal(openRouterGateway?.activation.globalReady, false);
  assert.equal(openRouterGateway?.activation.env, "OPENROUTER_ENABLED");
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

test("the shipped OrcaRouter key does not activate the Provider", async () => {
  const originalEnabled = process.env.ORCAROUTER_ENABLED;
  const originalKey = process.env.ORCAROUTER_API_KEY;
  delete process.env.ORCAROUTER_ENABLED;
  process.env.ORCAROUTER_API_KEY = "configured-but-disabled";
  try {
    const loaded = await loadGlobalModelGatewayConfig(
      resolve("config/model-gateway.global.json"),
    );
    const gateway = loaded?.gateways.find(
      (entry) => entry.slug === "orcarouter-default",
    );
    assert.equal(gateway?.activation.enabled, false);
    assert.equal(gateway?.activation.configured, true);
    assert.equal(gateway?.activation.globalReady, false);
  } finally {
    if (originalEnabled === undefined) delete process.env.ORCAROUTER_ENABLED;
    else process.env.ORCAROUTER_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.ORCAROUTER_API_KEY;
    else process.env.ORCAROUTER_API_KEY = originalKey;
  }
});

test.each([
  null,
  "",
  "   ",
  123,
  false,
  {},
  [],
  "INVALID-KEY",
  "INVALID KEY",
  "lowercase_key",
  "9INVALID_KEY",
  "KEY=value",
  "INVALID\nKEY",
])(
  "an explicitly malformed apiKeyEnv is rejected instead of enabling credential-free access: %j",
  async (apiKeyEnv) => {
    const config = baseConfig();
    config.gateways[0]!.apiKeyEnv = apiKeyEnv;
    await assert.rejects(
      loadConfig(config),
      /Invalid global model gateway config field: gateways\[0\]\.apiKeyEnv/,
    );
  },
);

test("an omitted apiKeyEnv and a valid declared key retain separate readiness and activation semantics", async () => {
  const enabledName = "SOURCEWEFT_TEST_NOAUTH_CONFIG_ENABLED";
  const keyName = "SOURCEWEFT_TEST_NOAUTH_CONFIG_KEY";
  const names = [enabledName, keyName, "OPENAI_API_KEY"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const config = baseConfig();
  config.gateways[0]!.activation = { env: enabledName, default: true };
  try {
    delete process.env[enabledName];
    delete process.env[keyName];
    process.env.OPENAI_API_KEY = "ambient-key-is-not-this-provider-credential";

    const omitted = (await loadConfig(config))?.gateways[0];
    assert.equal(omitted?.apiKeyEnv, undefined);
    assert.equal(omitted?.apiKey, undefined);
    assert.deepEqual(omitted?.activation, {
      env: enabledName,
      source: "default",
      enabled: true,
      configured: true,
      globalReady: true,
    });

    config.gateways[0]!.apiKeyEnv = `  ${keyName}\t`;
    const missingDeclaredKey = (await loadConfig(config))?.gateways[0];
    assert.equal(missingDeclaredKey?.apiKeyEnv, keyName);
    assert.equal(missingDeclaredKey?.apiKey, undefined);
    assert.equal(missingDeclaredKey?.activation.enabled, true);
    assert.equal(missingDeclaredKey?.activation.configured, false);
    assert.equal(missingDeclaredKey?.activation.globalReady, false);

    process.env[keyName] = "declared-local-key";
    const configured = (await loadConfig(config))?.gateways[0];
    assert.equal(configured?.apiKey, "declared-local-key");
    assert.equal(configured?.activation.enabled, true);
    assert.equal(configured?.activation.configured, true);
    assert.equal(configured?.activation.globalReady, true);

    process.env[enabledName] = "false";
    const disabled = (await loadConfig(config))?.gateways[0];
    assert.equal(disabled?.activation.enabled, false);
    assert.equal(disabled?.activation.configured, true);
    assert.equal(disabled?.activation.globalReady, false);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("undeclared OpenAI environment credentials and headers cannot change local System config or its safe hash", async () => {
  const enabledName = "SOURCEWEFT_TEST_NOAUTH_HASH_ENABLED";
  const ambient: Record<string, string> = {
    OPENAI_API_KEY: "ambient-api-key",
    OPENAI_ADMIN_KEY: "ambient-admin-key",
    OPENAI_ORGANIZATION: "ambient-lc-organization",
    OPENAI_ORG_ID: "ambient-sdk-organization",
    OPENAI_PROJECT_ID: "ambient-project",
    OPENAI_BASE_URL: "https://ambient-provider.example/v1",
    OPENAI_CUSTOM_HEADERS:
      "Authorization: Bearer ambient-header-key\nX-Ambient-Secret: ambient-secret",
  };
  const previous = new Map(
    [enabledName, ...Object.keys(ambient)].map((name) => [
      name,
      process.env[name],
    ]),
  );
  const config = baseConfig();
  config.gateways[0]!.activation = { env: enabledName, default: true };
  config.gateways[0]!.baseUrl = "http://127.0.0.1:11434/v1";
  try {
    for (const name of previous.keys()) delete process.env[name];
    const withoutAmbient = await loadConfig(config);
    for (const [name, value] of Object.entries(ambient))
      process.env[name] = value;
    const withAmbient = await loadConfig(config);

    assert.ok(withoutAmbient);
    assert.ok(withAmbient);
    assert.equal(withAmbient.versionHash, withoutAmbient.versionHash);
    assert.deepEqual(withAmbient.gateways, withoutAmbient.gateways);
    assert.equal(withAmbient.gateways[0]?.apiKey, undefined);
    assert.equal(withAmbient.gateways[0]?.activation.globalReady, true);
    assert.equal(withAmbient.gateways[0]?.baseUrl, "http://127.0.0.1:11434/v1");
    const safeConfiguration = JSON.stringify({
      hash: withAmbient.versionHash,
      gateways: withAmbient.gateways,
    });
    for (const value of Object.values(ambient))
      assert.equal(safeConfiguration.includes(value), false);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
