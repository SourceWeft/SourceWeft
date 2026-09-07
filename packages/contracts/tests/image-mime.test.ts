import assert from "node:assert/strict";
import test from "node:test";
import { sniffImageMimeType } from "../src/artifact-files";
const bytesFromAscii = (text: string) => new TextEncoder().encode(text);

test("raster signatures distinguish PNG, JPEG, WebP and unsupported GIF from unknown bytes", () => {
  assert.equal(
    sniffImageMimeType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
    ),
    "image/png",
  );
  assert.equal(
    sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.equal(
    sniffImageMimeType(bytesFromAscii("RIFF0000WEBP")),
    "image/webp",
  );
  assert.equal(sniffImageMimeType(bytesFromAscii("GIF89a")), "image/gif");
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([0xff, 0xd8]),
    bytesFromAscii("RIFF0000WAVE"),
    bytesFromAscii("<svg></svg>"),
  ]) {
    assert.equal(sniffImageMimeType(bytes), null);
  }
});
