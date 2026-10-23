import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelGateway,
  resolveModelGatewayConfig,
  resolveRequestTarget,
  type ImageAspectRatio,
  type ImageGenerationRequestConfig,
  type ModelGatewayConfig,
} from "../src/index";
import {
  buildImageSizingFields,
  fitImageDimensionsToNativeEnvelope,
  normalizeGeneratedImages,
  readImageDimensions,
  resolveImageGenerationRequestConfig,
} from "../src/adapters/image-utils";
import { createJsonResponse } from "./helpers";

const fetchStub: typeof fetch = async () => new Response("{}", { status: 200 });

// 1x1 PNG (the example DeepInfra publishes in its image output schema).
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12PQz3wAAAJDAXkkWn+MAAAAAElFTkSuQmCC";

/** A JPEG prefix: SOI, an APP0 segment, then SOF0 declaring width x height. */
function jpegHeader(width: number, height: number) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0]);
}

function jpegDataUrl(width: number, height: number) {
  return `data:image/jpeg;base64,${Buffer.from(jpegHeader(width, height)).toString("base64")}`;
}

type Captured = { url: string; body: Record<string, unknown>; init: RequestInit };

function nativeDeepInfraReply(extra: Record<string, unknown> = {}) {
  return {
    images: [jpegDataUrl(768, 1344)],
    nsfw_content_detected: [false],
    seed: 7,
    request_id: "req-1",
    inference_status: { status: "succeeded", runtime_ms: 1180, cost: 0.005 },
    ...extra,
  };
}

function imageGateway(input: {
  providerName?: string;
  providerKind?: string;
  baseUrl?: string;
  request?: Partial<ImageGenerationRequestConfig>;
  reply?: Record<string, unknown>;
  requests: Captured[];
}) {
  const providerName = input.providerName ?? "deepinfra";
  const config: ModelGatewayConfig = {
    fetch: async (url, init) => {
      input.requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        init: init ?? {},
      });
      return createJsonResponse(input.reply ?? nativeDeepInfraReply());
    },
    providers: {
      [providerName]: {
        kind: input.providerKind ?? "deepinfra",
        baseUrl: input.baseUrl ?? "https://api.deepinfra.com/v1",
        apiKey: "provider-key",
      },
    },
    modelRoutes: {
      "image-default": {
        strategy: "priority",
        targets: [
          {
            provider: providerName,
            model: "PrunaAI/p-image",
            priority: 1,
            ...(input.request
              ? {
                  imageGeneration: {
                    request: input.request as ImageGenerationRequestConfig,
                  },
                }
              : {}),
          },
        ],
      },
    },
  };
  return createModelGateway(config);
}

test("resolveImageGenerationRequestConfig defaults to the OpenAI size path", () => {
  assert.deepEqual(resolveImageGenerationRequestConfig({}), {
    endpoint: "openai",
    sizing: "size",
  });
  assert.deepEqual(
    resolveImageGenerationRequestConfig({
      imageGeneration: { request: { endpoint: "native", sizing: "aspect_ratio" } },
    }),
    { endpoint: "native", sizing: "aspect_ratio" },
  );
  // A malformed value never reaches the wire; it degrades to the default.
  assert.deepEqual(
    resolveImageGenerationRequestConfig({
      imageGeneration: {
        request: { endpoint: "grpc", sizing: "pixels" } as never,
      },
    }),
    { endpoint: "openai", sizing: "size" },
  );
});

test("resolveRequestTarget carries the image request convention from the route", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "k",
      },
    },
    modelRoutes: {
      "image-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "PrunaAI/p-image",
            priority: 1,
            imageGeneration: {
              request: { endpoint: "native", sizing: "aspect_ratio" },
            },
          },
        ],
      },
    },
  });
  const target = await resolveRequestTarget(resolved, { model: "image-default" });
  assert.deepEqual(target.imageGeneration, {
    request: { endpoint: "native", sizing: "aspect_ratio" },
  });
});

test("buildImageSizingFields covers every sizing convention", () => {
  assert.deepEqual(buildImageSizingFields("size", "16:9"), { size: "1344x768" });
  assert.deepEqual(buildImageSizingFields("size", "auto"), { size: "1024x1024" });
  assert.deepEqual(buildImageSizingFields("dimensions", "16:9"), {
    width: 1344,
    height: 768,
  });
  assert.deepEqual(buildImageSizingFields("dimensions", "auto"), {});
  assert.deepEqual(buildImageSizingFields("dimensions", undefined), {});
  for (const ratio of ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const) {
    assert.deepEqual(buildImageSizingFields("aspect_ratio", ratio), {
      aspect_ratio: ratio,
    });
  }
  assert.deepEqual(buildImageSizingFields("aspect_ratio", "auto"), {});
  // Ratios the native enum lacks go through `custom` with explicit pixels.
  assert.deepEqual(buildImageSizingFields("aspect_ratio", "4:5"), {
    aspect_ratio: "custom",
    width: 896,
    height: 1152,
  });
  assert.deepEqual(buildImageSizingFields("aspect_ratio", "5:4"), {
    aspect_ratio: "custom",
    width: 1152,
    height: 896,
  });
  // 21:9 maps to 1536x672, above the 1440 ceiling: both edges scale together.
  assert.deepEqual(buildImageSizingFields("aspect_ratio", "21:9"), {
    aspect_ratio: "custom",
    width: 1440,
    height: 624,
  });
  assert.deepEqual(buildImageSizingFields("dimensions", "21:9"), {
    width: 1440,
    height: 624,
  });
});

test("fitImageDimensionsToNativeEnvelope snaps to 16 and clamps to 256-1440", () => {
  assert.deepEqual(fitImageDimensionsToNativeEnvelope({ width: 1000, height: 1000 }), {
    width: 1008,
    height: 1008,
  });
  assert.deepEqual(fitImageDimensionsToNativeEnvelope({ width: 2880, height: 720 }), {
    width: 1440,
    height: 368,
  });
  assert.deepEqual(fitImageDimensionsToNativeEnvelope({ width: 100, height: 100 }), {
    width: 256,
    height: 256,
  });
  assert.deepEqual(fitImageDimensionsToNativeEnvelope({ width: 1440, height: 1440 }), {
    width: 1440,
    height: 1440,
  });
});

test("readImageDimensions reads PNG, JPEG and WebP headers", () => {
  assert.deepEqual(
    readImageDimensions(Buffer.from(PNG_1X1_BASE64, "base64")),
    { width: 1, height: 1 },
  );
  assert.deepEqual(readImageDimensions(jpegHeader(1344, 768)), {
    width: 1344,
    height: 768,
  });
  const webp = Uint8Array.from([
    ...Buffer.from("RIFF"), 0x1a, 0, 0, 0, ...Buffer.from("WEBPVP8 "),
    0x0e, 0, 0, 0, // chunk size
    0x10, 0x02, 0x00, // frame tag
    0x9d, 0x01, 0x2a, // start code
    0x40, 0x01, // width 320
    0xf0, 0x00, // height 240
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assert.deepEqual(readImageDimensions(webp), { width: 320, height: 240 });
  assert.equal(readImageDimensions(Buffer.from("not an image")), undefined);
});

test("normalizeGeneratedImages parses bare data URLs and plain URLs", () => {
  const images = normalizeGeneratedImages({
    images: [
      `data:image/png;base64,${PNG_1X1_BASE64}`,
      "https://cdn.example.com/out.png",
      42,
    ],
  });
  assert.deepEqual(images, [
    { b64Json: PNG_1X1_BASE64, mimeType: "image/png", width: 1, height: 1 },
    { url: "https://cdn.example.com/out.png" },
  ]);
});

test("native aspect_ratio sends the enum value to {baseUrl}/inference/{model}", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "aspect_ratio" },
  });

  const result = await gateway.images.generate({
    model: "image-default",
    prompt: "a lighthouse at dusk",
    aspectRatio: "9:16",
    style: "pixel",
    quality: "standard",
  });

  assert.equal(requests[0]?.url, "https://api.deepinfra.com/v1/inference/PrunaAI/p-image");
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer provider-key",
  );
  assert.deepEqual(requests[0]?.body, {
    prompt: "a lighthouse at dusk\n\nStyle: Use a crisp pixel art style.",
    aspect_ratio: "9:16",
  });

  // Same result shape as the OpenAI path: base64 + mime + pixel size.
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.mimeType, "image/jpeg");
  assert.equal(
    result.images[0]?.b64Json,
    Buffer.from(jpegHeader(768, 1344)).toString("base64"),
  );
  assert.equal(result.images[0]?.width, 768);
  assert.equal(result.images[0]?.height, 1344);
  assert.equal(result.images[0]?.url, undefined);
  assert.equal(result.providerModel, "PrunaAI/p-image");
  // Quality handling is unchanged: still recorded for per-image pricing.
  assert.equal(result.usage?.imageQuality, "standard");
  assert.equal(result.usage?.imageSize, "768x1344");
  assert.equal(result.usage?.outputImageCount, 1);
});

test("native aspect_ratio falls back to custom pixels for ratios outside the enum", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "aspect_ratio" },
  });

  const results = [
    await gateway.images.generate({
      model: "image-default",
      prompt: "wide banner",
      aspectRatio: "21:9",
    }),
    await gateway.images.generate({
      model: "image-default",
      prompt: "portrait poster",
      aspectRatio: "4:5",
    }),
    await gateway.images.generate({
      model: "image-default",
      prompt: "whatever fits",
      aspectRatio: "auto",
    }),
  ];

  assert.deepEqual(requests[0]?.body, {
    prompt: "wide banner",
    aspect_ratio: "custom",
    width: 1440,
    height: 624,
  });
  // Pricing sees the pixels that were actually requested, not the table value.
  assert.equal(results[0]?.usage?.imageSize, "1440x624");
  assert.equal(results[2]?.usage?.imageSize, "1024x1024");
  assert.deepEqual(requests[1]?.body, {
    prompt: "portrait poster",
    aspect_ratio: "custom",
    width: 896,
    height: 1152,
  });
  // `auto` leaves the choice to the provider instead of forcing a square.
  assert.deepEqual(requests[2]?.body, { prompt: "whatever fits" });
});

test("native dimensions sends width/height; native size keeps the WxH string", async () => {
  const requests: Captured[] = [];
  const dimensionsGateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "dimensions" },
  });
  await dimensionsGateway.images.generate({
    model: "image-default",
    prompt: "landscape",
    aspectRatio: "16:9",
  });
  const sizeGateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "size" },
  });
  await sizeGateway.images.generate({
    model: "image-default",
    prompt: "landscape",
    aspectRatio: "16:9",
  });

  assert.deepEqual(requests[0]?.body, {
    prompt: "landscape",
    width: 1344,
    height: 768,
  });
  assert.deepEqual(requests[1]?.body, {
    prompt: "landscape",
    size: "1344x768",
  });
});

test("inference_status.cost becomes the actual provider cost like OpenRouter usage.cost", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "aspect_ratio" },
  });
  const result = await gateway.images.generate({
    model: "image-default",
    prompt: "a lighthouse at dusk",
    aspectRatio: "16:9",
  });

  assert.equal(result.observation?.cost?.effectiveUsd, 0.005);
  assert.equal(result.observation?.cost?.inlineUsd, 0.005);
  assert.equal(result.observation?.cost?.source, "provider_inline");
  assert.equal(result.observation?.cost?.status, "inline");
  assert.equal(
    result.observation?.provenance.inlineCost,
    "provider:deepinfra.inference_status.cost",
  );
});

test("an openai-compatible gateway can declare the same native block and still report cost", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    providerName: "ImagesCo",
    providerKind: "openai-compatible",
    baseUrl: "https://images.example.com/v1/",
    request: { endpoint: "native", sizing: "dimensions" },
  });
  const result = await gateway.images.generate({
    model: "image-default",
    prompt: "a lighthouse at dusk",
    aspectRatio: "3:2",
  });

  assert.equal(requests[0]?.url, "https://images.example.com/v1/inference/PrunaAI/p-image");
  assert.deepEqual(requests[0]?.body, {
    prompt: "a lighthouse at dusk",
    width: 1248,
    height: 832,
  });
  assert.equal(result.observation?.cost?.effectiveUsd, 0.005);
  assert.equal(
    result.observation?.provenance.inlineCost,
    "provider:imagesco.inference_status.cost",
  );
});

test("a native reply without inference_status.cost leaves the cost unset", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    request: { endpoint: "native", sizing: "aspect_ratio" },
    reply: nativeDeepInfraReply({ inference_status: { status: "succeeded" } }),
  });
  const result = await gateway.images.generate({
    model: "image-default",
    prompt: "a lighthouse at dusk",
  });
  assert.equal(result.observation?.cost, undefined);
});

test("openai + size is byte-for-byte what a profile without the block sends", async () => {
  const withoutBlock: Captured[] = [];
  const withDefaultBlock: Captured[] = [];
  const openaiReply = {
    model: "PrunaAI/p-image",
    data: [{ b64_json: PNG_1X1_BASE64 }],
  };
  const payload = {
    model: "image-default",
    prompt: "draw a calm study desk",
    aspectRatio: "16:9" as ImageAspectRatio,
    quality: "higher" as const,
    style: "ghibli" as const,
    count: 2,
  };

  await imageGateway({ requests: withoutBlock, reply: openaiReply }).images.generate(
    payload,
  );
  await imageGateway({
    requests: withDefaultBlock,
    reply: openaiReply,
    request: { endpoint: "openai", sizing: "size" },
  }).images.generate(payload);

  assert.equal(withoutBlock[0]?.url, "https://api.deepinfra.com/v1/openai/images/generations");
  assert.equal(withoutBlock[0]?.url, withDefaultBlock[0]?.url);
  assert.equal(String(withoutBlock[0]?.init.body), String(withDefaultBlock[0]?.init.body));
  assert.deepEqual(withoutBlock[0]?.body, {
    model: "PrunaAI/p-image",
    prompt:
      "draw a calm study desk\n\nStyle: Use a warm hand-painted animation-inspired style.",
    n: 2,
    response_format: "b64_json",
    size: "1344x768",
    quality: "hd",
  });
});

test("openai endpoint with aspect_ratio sizing keeps the OpenAI envelope", async () => {
  const requests: Captured[] = [];
  const gateway = imageGateway({
    requests,
    reply: { data: [{ b64_json: PNG_1X1_BASE64 }] },
    request: { endpoint: "openai", sizing: "aspect_ratio" },
  });
  await gateway.images.generate({
    model: "image-default",
    prompt: "square",
    aspectRatio: "1:1",
  });
  assert.equal(requests[0]?.url, "https://api.deepinfra.com/v1/openai/images/generations");
  assert.deepEqual(requests[0]?.body, {
    model: "PrunaAI/p-image",
    prompt: "square",
    n: 1,
    response_format: "b64_json",
    aspect_ratio: "1:1",
  });
});
