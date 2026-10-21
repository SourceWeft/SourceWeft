import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createHtmlVisualReviewTools } from "../src/html/visual-review";
function pngOf(width: number, height: number) {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
function jpegOf(width: number, height: number) {
  // SOI, an APP0 segment, then a baseline SOF0 frame header.
  const app0 = [
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
  ];
  return Buffer.from([
    0xff,
    0xd8,
    ...app0,
    ...sof0,
    ...Array(9).fill(0),
    0xff,
    0xd9,
  ]);
}
const png = pngOf(1440, 900);
function factory(
  content: string,
  profile = true,
  images: Record<string, Buffer> = {},
) {
  const complete = vi.fn().mockResolvedValue({ raw: { content } }),
    download = vi.fn(
      async ({ sandboxPath }: { sandboxPath: string }) =>
        images[sandboxPath] ?? png,
    );
  const tools = createHtmlVisualReviewTools({
    toolIds: ["review_html_visuals"],
    context: {
      userMessageId: "message",
      shouldBindAgentTool: () => true,
      turnState: {
        review_html_visuals: {
          visionProfile: profile
            ? { gatewayConfigId: "g", profileAlias: "vision", modelAlias: "v" }
            : null,
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: download,
      },
      modelGateway: {
        getClient: async () => ({ chat: { complete } }),
      } as never,
    },
  });
  return { tool: tools[0]!.tool, complete, download };
}
test("missing vision profile is a failure without reading images or selecting another model", async () => {
  const f = factory("", false);
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/a.png"],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "VISION_PROFILE_UNAVAILABLE");
  assert.equal(f.complete.mock.calls.length, 0);
  assert.equal(f.download.mock.calls.length, 0);
});
test("review rejects a path escaping the authorized sandbox root", async () => {
  const f = factory("");
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/../private/a.png"],
      criteria: "Check readability",
    }),
    /NOT_AUTHORIZED/,
  );
  assert.equal(f.complete.mock.calls.length, 0);
});
test("every image must have a unique complete verdict", async () => {
  const f = factory(
    JSON.stringify({
      verdicts: [{ imageIndex: 1, severity: "none", issues: [] }],
    }),
  );
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/a.png", "/workspace/b.png"],
      criteria: "Check layout",
    }),
    /INCOMPLETE/,
  );
  assert.equal(f.complete.mock.calls.length, 1);
});
test("major findings fail a complete review", async () => {
  const f = factory(
    JSON.stringify({
      verdicts: [
        { imageIndex: 1, severity: "major", issues: ["Clipped title"] },
      ],
    }),
  );
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/a.png"],
      criteria: "Check layout",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reviewedImages, 1);
});
test("a 390×12000 full-page JPEG is rejected with its index, path and size before any model call", async () => {
  const f = factory("", true, {
    "/workspace/qa/viewport-390.jpg": jpegOf(390, 12000),
  });
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: [
        "/workspace/qa/viewport-1440.png",
        "/workspace/qa/viewport-390.jpg",
      ],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "HTML_QA_IMAGE_DIMENSIONS_UNSUPPORTED");
  assert.equal(r.reviewedImages, 0);
  assert.deepEqual(r.rejectedImages, [
    {
      imageIndex: 2,
      path: "/workspace/qa/viewport-390.jpg",
      width: 390,
      height: 12000,
      problem: "390×12000 exceeds the 8000px long-edge limit",
    },
  ]);
  assert.match(r.instruction, /QA script.*qa\.json `images`/);
  assert.equal(f.complete.mock.calls.length, 0);
});
test("extreme aspect ratios within the long-edge limit are rejected", async () => {
  const f = factory("", true, {
    "/workspace/qa/tall.png": pngOf(390, 7000),
    "/workspace/qa/wide.jpg": jpegOf(4000, 500),
  });
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/qa/tall.png", "/workspace/qa/wide.jpg"],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, false);
  assert.deepEqual(
    r.rejectedImages.map((image: { imageIndex: number; problem: string }) => [
      image.imageIndex,
      image.problem,
    ]),
    [
      [1, "390×7000 has aspect ratio 17.9:1, above the 6:1 limit"],
      [2, "4000×500 has aspect ratio 8.0:1, above the 6:1 limit"],
    ],
  );
  assert.equal(f.complete.mock.calls.length, 0);
});
test("QA slices of every viewport are accepted and reviewed", async () => {
  const f = factory(
    JSON.stringify({
      verdicts: [1, 2, 3].map((imageIndex) => ({
        imageIndex,
        severity: "none",
        issues: [],
      })),
    }),
    true,
    {
      "/workspace/qa/a.jpg": jpegOf(1440, 2000),
      "/workspace/qa/b.jpg": jpegOf(768, 2000),
      "/workspace/qa/c.jpg": jpegOf(390, 2000),
    },
  );
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: [
        "/workspace/qa/a.jpg",
        "/workspace/qa/b.jpg",
        "/workspace/qa/c.jpg",
      ],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, true);
  assert.equal(r.reviewedImages, 3);
  assert.equal(f.complete.mock.calls.length, 1);
});
test("an image without a readable size header is invalid content", async () => {
  const f = factory("", true, {
    "/workspace/qa/broken.png": Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0,
    ]),
  });
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/qa/broken.png"],
      criteria: "Check readability",
    }),
    /CONTENT_INVALID/,
  );
  assert.equal(f.complete.mock.calls.length, 0);
});
test("a provider 400 about the image becomes an actionable failed review", async () => {
  const f = factory("");
  f.complete.mockRejectedValueOnce(
    Object.assign(new Error("unsupported image"), {
      code: "BAD_REQUEST",
      statusCode: 400,
    }),
  );
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/qa/a.png"],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "HTML_QA_IMAGE_REJECTED_BY_MODEL");
  assert.deepEqual(r.rejectedImages, [
    { imageIndex: 1, path: "/workspace/qa/a.png", width: 1440, height: 900 },
  ]);
  assert.equal(r.providerMessage, "unsupported image");
});
test("provider complaints about image size, aspect or format ask for slices", async () => {
  for (const message of [
    "Image exceeds the maximum allowed dimensions",
    "Invalid image: aspect ratio too large",
    "image format not recognised",
    "Could not decode image data",
  ]) {
    const f = factory("");
    f.complete.mockRejectedValueOnce(
      Object.assign(new Error(message), { statusCode: 400 }),
    );
    const r = JSON.parse(
      await f.tool.invoke({
        imagePaths: ["/workspace/qa/a.png"],
        criteria: "Check readability",
      }),
    );
    assert.equal(r.reason, "HTML_QA_IMAGE_REJECTED_BY_MODEL", message);
    assert.match(r.instruction, /QA script/);
  }
});
test("a model that cannot take image input is reported, not sent back to re-slice", async () => {
  for (const message of [
    "model does not support image input",
    "This model doesn't support images",
    "Image input is not supported for this model",
    "deepseek-chat is a text-only model; image content not allowed",
    "The requested model is not a multimodal model",
  ]) {
    const f = factory("");
    f.complete.mockRejectedValueOnce(
      Object.assign(new Error(message), { code: "BAD_REQUEST" }),
    );
    const r = JSON.parse(
      await f.tool.invoke({
        imagePaths: ["/workspace/qa/a.png"],
        criteria: "Check readability",
      }),
    );
    assert.equal(r.passed, false, message);
    assert.equal(r.reason, "HTML_QA_VISION_MODEL_UNAVAILABLE", message);
    assert.equal(r.rejectedImages, undefined);
    assert.match(r.instruction, /Do not re-run QA/);
    assert.doesNotMatch(r.instruction, /slices/);
  }
});
test("a 400 that only mentions an image field without a size or capability cause still throws", async () => {
  const f = factory("");
  f.complete.mockRejectedValueOnce(
    Object.assign(new Error("image_url.detail must be one of low, high"), {
      code: "BAD_REQUEST",
      statusCode: 400,
    }),
  );
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/qa/a.png"],
      criteria: "Check readability",
    }),
    /image_url\.detail/,
  );
});
test("other provider failures still throw", async () => {
  const f = factory("");
  f.complete.mockRejectedValueOnce(
    Object.assign(new Error("rate limited"), {
      code: "RATE_LIMIT",
      statusCode: 429,
    }),
  );
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/qa/a.png"],
      criteria: "Check readability",
    }),
    /rate limited/,
  );
});
