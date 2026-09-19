import assert from "node:assert/strict";
import { test } from "vitest";
import sharp from "sharp";
import { normalizeImageForPdf2Markdown } from "./image-normalizer";

test("uploaded AVIF is decoded into PNG by the patched image library", async () => {
  const avif = await sharp({
    create: { width: 8, height: 6, channels: 3, background: "#3467ab" },
  })
    .avif()
    .toBuffer();
  const result = await normalizeImageForPdf2Markdown({
    content: avif,
    fileName: "upload.avif",
    mimeType: "image/avif",
  });
  assert.equal(result.fileName, "upload.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.originalMimeType, "image/avif");
  assert.equal(result.originalFileName, "upload.avif");
  const metadata = await sharp(result.content).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 6);
});

test("PNG uploads retain their bytes and metadata", async () => {
  const input = {
    content: await sharp({
      create: { width: 2, height: 3, channels: 3, background: "white" },
    })
      .png()
      .toBuffer(),
    fileName: "upload.png",
    mimeType: "image/png",
  };
  assert.equal(await normalizeImageForPdf2Markdown(input), input);
});

test("invalid AVIF bytes are rejected instead of returning a mislabeled PNG", async () => {
  await assert.rejects(
    normalizeImageForPdf2Markdown({
      content: Buffer.from("invalid image"),
      fileName: "upload.avif",
      mimeType: "image/avif",
    }),
  );
});
