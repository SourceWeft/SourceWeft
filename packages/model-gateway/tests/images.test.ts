import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";
import { createJsonResponse } from "./helpers";

test("images.generate sends SiliconflowCN image_size and batch_size", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return createJsonResponse({
        model: "Kwai-Kolors/Kolors",
        images: [{ url: "https://cdn.example.com/image.png" }],
      });
    },
    providers: {
      SiliconflowCN: {
        kind: "siliconflow-cn",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key",
      },
    },
    modelRoutes: {
      "image-default": {
        strategy: "priority",
        targets: [
          {
            provider: "SiliconflowCN",
            model: "Kwai-Kolors/Kolors",
            priority: 1,
          },
        ],
      },
    },
  });

  const result = await gateway.images.generate({
    model: "image-default",
    prompt: "draw a calm study desk",
    aspectRatio: "16:9",
    quality: "higher",
    count: 2,
  });

  assert.equal(requests[0]?.url, "https://api.siliconflow.cn/v1/images/generations");
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer sf-key",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    model: "Kwai-Kolors/Kolors",
    prompt: "draw a calm study desk",
    image_size: "2048x2048",
    batch_size: 2,
  });
  assert.equal(result.provider, "SiliconflowCN");
  assert.equal(result.images[0]?.url, "https://cdn.example.com/image.png");
});

test("images.generate sends DeepInfra image requests through OpenAI-compatible URL", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return createJsonResponse({
        model: "black-forest-labs/FLUX-2-klein-4b",
        data: [{ b64_json: "aW1hZ2U=" }],
      });
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "image-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "black-forest-labs/FLUX-2-klein-4b",
            priority: 1,
          },
        ],
      },
    },
  });

  await gateway.images.generate({
    model: "image-default",
    prompt: "draw a small icon",
    aspectRatio: "1:1",
  });

  assert.equal(
    requests[0]?.url,
    "https://api.deepinfra.com/v1/openai/images/generations",
  );
});
