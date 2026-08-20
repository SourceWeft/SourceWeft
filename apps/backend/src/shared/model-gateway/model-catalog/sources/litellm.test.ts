import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./litellm";

const { parseImageSizeKey, toTier } = testExports;

test("parseImageSizeKey extracts base id, quality, and size from LiteLLM keys", () => {
  assert.deepEqual(parseImageSizeKey("high/1024-x-1024/gpt-image-1"), {
    baseId: "gpt-image-1",
    quality: "high",
    size: "1024x1024",
  });
  // provider-prefixed quality tier
  assert.deepEqual(parseImageSizeKey("azure/hd/1024-x-1024/dall-e-3"), {
    baseId: "dall-e-3",
    quality: "hd",
    size: "1024x1024",
  });
  // a non-quality segment before the size is not treated as a quality
  assert.deepEqual(parseImageSizeKey("1024-x-1024/dall-e-2"), {
    baseId: "dall-e-2",
    quality: undefined,
    size: "1024x1024",
  });
  // trailing step count is dropped from the base id
  assert.deepEqual(parseImageSizeKey("1024-x-1024/50-steps/some-model"), {
    baseId: "some-model",
    quality: undefined,
    size: "1024x1024",
  });
});

test("parseImageSizeKey returns null for keys without a WxH segment", () => {
  assert.equal(parseImageSizeKey("gpt-image-1"), null);
  assert.equal(parseImageSizeKey("openai/gpt-4o"), null);
});

test("toTier reads per-image and per-pixel prices, null when neither present", () => {
  assert.deepEqual(
    toTier({ input_cost_per_image: 0.167 }, "high", "1024x1024"),
    { quality: "high", size: "1024x1024", perImage: 0.167, perPixel: null },
  );
  assert.deepEqual(
    toTier({ input_cost_per_pixel: 7.629e-8 }, "hd", "1024x1024"),
    { quality: "hd", size: "1024x1024", perImage: null, perPixel: 7.629e-8 },
  );
  assert.equal(toTier({ max_input_tokens: 100 }, undefined, "512x512"), null);
});
