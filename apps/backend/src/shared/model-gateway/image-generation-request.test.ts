import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  buildRouteConstraintsJson,
  mergeGlobalProfileConfigJson,
} from "./config-sync";
import { loadGlobalModelGatewayConfig } from "./global-config";
import { normalizeRouteImageGeneration } from "./runtime";

const ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

function baseConfig(imageGeneration?: unknown): Record<string, unknown> {
  return {
    gateways: [
      {
        slug: "deepinfra-default",
        baseUrl: "https://api.deepinfra.com/v1",
        providerName: "deepinfra",
        providerKind: "deepinfra",
        supports: ["chat", "embeddings", "image"],
        isDefault: true,
        activation: { env: "SOURCEWEFT_TEST_DEEPINFRA_ENABLED", default: true },
      },
    ],
    chatProfiles: [
      {
        profileAlias: "chat",
        modelAlias: "test-chat",
        gatewaySlug: "deepinfra-default",
        providerName: "deepinfra",
        isDefault: true,
        isActive: true,
      },
    ],
    embeddingProfiles: [
      {
        profileAlias: "embedding",
        modelAlias: "test-embedding",
        gatewaySlug: "deepinfra-default",
        providerName: "deepinfra",
        isDefault: true,
        isActive: true,
      },
    ],
    imageProfiles: [
      {
        profileAlias: "image-default",
        modelAlias: "image-default",
        gatewaySlug: "deepinfra-default",
        providerName: "deepinfra",
        targetModel: "PrunaAI/p-image",
        isDefault: true,
        isActive: true,
        ...(imageGeneration !== undefined ? { imageGeneration } : {}),
      },
    ],
  };
}

async function loadConfig(config: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "sourceweft-image-request-"));
  const configPath = join(dir, "model-gateway.global.json");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  try {
    return await loadGlobalModelGatewayConfig(configPath);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("imageGeneration.request is parsed next to the untouched controls block", async () => {
  const loaded = await loadConfig(
    baseConfig({
      controls: { aspectRatio: { values: ASPECT_RATIOS } },
      request: { endpoint: "native", sizing: "aspect_ratio" },
    }),
  );
  assert.deepEqual(loaded?.imageProfiles[0]?.imageGeneration, {
    controls: { aspectRatio: { values: ASPECT_RATIOS } },
    request: { endpoint: "native", sizing: "aspect_ratio" },
  });
});

test("a partial request block is completed with the OpenAI size defaults", async () => {
  const native = await loadConfig(baseConfig({ request: { endpoint: "native" } }));
  assert.deepEqual(native?.imageProfiles[0]?.imageGeneration?.request, {
    endpoint: "native",
    sizing: "size",
  });
  const dimensions = await loadConfig(
    baseConfig({ request: { sizing: "dimensions" } }),
  );
  assert.deepEqual(dimensions?.imageProfiles[0]?.imageGeneration?.request, {
    endpoint: "openai",
    sizing: "dimensions",
  });
});

test("a profile without the request block keeps its imageGeneration as written", async () => {
  const controlsOnly = await loadConfig(
    baseConfig({ controls: { aspectRatio: { values: ["auto", "1:1"] } } }),
  );
  assert.deepEqual(controlsOnly?.imageProfiles[0]?.imageGeneration, {
    controls: { aspectRatio: { values: ["auto", "1:1"] } },
  });
  const none = await loadConfig(baseConfig());
  assert.equal(none?.imageProfiles[0]?.imageGeneration, undefined);
});

test.each([
  [
    "unknown endpoint",
    { request: { endpoint: "grpc", sizing: "size" } },
    /imageProfiles\[0\]\.imageGeneration\.request\.endpoint \(expected "openai" or "native", received "grpc"\)/,
  ],
  [
    "unknown sizing",
    { request: { endpoint: "native", sizing: "pixels" } },
    /imageProfiles\[0\]\.imageGeneration\.request\.sizing \(expected "size", "dimensions" or "aspect_ratio", received "pixels"\)/,
  ],
  [
    "unknown request field",
    { request: { endpoint: "native", sizing: "size", model: "x" } },
    /imageProfiles\[0\]\.imageGeneration\.request\.model \(unknown field/,
  ],
  [
    "request is not an object",
    { request: "native" },
    /imageProfiles\[0\]\.imageGeneration\.request \(expected an object/,
  ],
  [
    "imageGeneration is not an object",
    ["native"],
    /imageProfiles\[0\]\.imageGeneration$/,
  ],
])("rejects an invalid imageGeneration block: %s", async (_name, block, pattern) => {
  await assert.rejects(loadConfig(baseConfig(block)), pattern);
});

test("the request block is persisted into the profile configJson and every route row", () => {
  const entry = {
    targetModel: "PrunaAI/p-image",
    imageGeneration: {
      controls: { aspectRatio: { values: ASPECT_RATIOS } },
      request: { endpoint: "native" as const, sizing: "aspect_ratio" as const },
    },
  };
  const configJson = mergeGlobalProfileConfigJson({
    existing: false,
    existingConfigJson: {},
    pricingGatewayConfigId: "deepinfra-gateway",
    entry,
    now: new Date("2026-10-24T00:00:00.000Z"),
  });
  assert.deepEqual(configJson.imageGeneration, entry.imageGeneration);

  assert.deepEqual(
    buildRouteConstraintsJson({
      providerRouting: { only: ["deepinfra"] },
      imageGeneration: entry.imageGeneration,
    }),
    {
      providerRouting: { only: ["deepinfra"] },
      imageGeneration: { request: { endpoint: "native", sizing: "aspect_ratio" } },
    },
  );
  // `controls` is a UI concern; the route row carries only the wire convention.
  assert.deepEqual(
    buildRouteConstraintsJson({
      imageGeneration: { controls: { aspectRatio: { values: ["auto"] } } },
    }),
    {},
  );
  assert.deepEqual(buildRouteConstraintsJson({}), {});
});

test("normalizeRouteImageGeneration reads only a well-formed convention from route constraints", () => {
  assert.deepEqual(
    normalizeRouteImageGeneration({
      providerRouting: { only: ["deepinfra"] },
      imageGeneration: { request: { endpoint: "native", sizing: "dimensions" } },
    }),
    { request: { endpoint: "native", sizing: "dimensions" } },
  );
  assert.equal(normalizeRouteImageGeneration({}), undefined);
  assert.equal(normalizeRouteImageGeneration(null), undefined);
  assert.equal(
    normalizeRouteImageGeneration({ imageGeneration: { controls: {} } }),
    undefined,
  );
  assert.equal(
    normalizeRouteImageGeneration({
      imageGeneration: { request: { endpoint: "native", sizing: "pixels" } },
    }),
    undefined,
  );
});
