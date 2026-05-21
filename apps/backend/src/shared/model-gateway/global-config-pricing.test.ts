import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadGlobalModelGatewayConfig } from "./global-config";

function baseConfig(): Record<string, unknown> & {
  chatProfiles: Array<Record<string, unknown>>;
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
