import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";

for (const path of [
  "apps/web/app/favicon.ico",
  "apps/docs/app/favicon.ico",
  "apps/desktop/src-tauri/icons/icon.ico",
  "apps/mobile/src-tauri/icons/icon.ico",
]) {
  test(`${path} has decodable RGBA PNG entries with the expected artwork`, async () => {
    const ico = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(ico.readUInt16LE(2), 1);
    const count = ico.readUInt16LE(4);
    assert.equal(count, 3);
    for (let index = 0; index < count; index++) {
      const entry = 6 + 16 * index;
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      const png = ico.subarray(offset, offset + length);
      assert.equal(ico.readUInt16LE(entry + 6), 32);
      const { data, info } = await sharp(png)
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 4, "32-bit ICO payload must include alpha");
      assert.equal(info.width, ico[entry] || 256);
      assert.equal(info.height, ico[entry + 1] || 256);
      if (!path.startsWith("apps/mobile/")) {
        assert.equal(data[3], 0, "rounded icon corners are transparent");
        let blackPixels = 0;
        let whitePixels = 0;
        for (let pixel = 0; pixel < data.length; pixel += 4) {
          if (data[pixel + 3] !== 255) continue;
          const rgb = [...data.subarray(pixel, pixel + 3)];
          if (rgb.every((channel) => channel < 32)) blackPixels++;
          if (rgb.every((channel) => channel > 223)) whitePixels++;
        }
        assert.ok(blackPixels > info.width * info.height * 0.1, "black SW mark is visible");
        assert.ok(whitePixels > info.width * info.height * 0.3, "white rounded background is visible");
      } else {
        for (let pixel = 3; pixel < data.length; pixel += 4)
          assert.equal(data[pixel], 255, "app artwork remains opaque");
      }
    }
  });
}
