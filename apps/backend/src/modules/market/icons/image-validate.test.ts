import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  KNOWN_DEFAULT_IMAGE_HASHES,
  looksLikeGithubIdenticon,
  MAX_ICON_PIXELS,
  sha256Hex,
  validateImage,
} from "./image-validate";

// The 16 × 16 globe Google's favicon service returns for an unknown domain.
const GOOGLE_GLOBE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsSAAALEgHS3X78AAACiElEQVQ4EaVTzU8TURCf2tJuS7tQtlRb6UKBIkQwkRRSEzkQgyEc6lkOKgcOph78Y+CgjXjDs2i44FXY9AMTlQRUELZapVlouy3d7kKtb0Zr0MSLTvL2zb75eL838xtTvV6H/xELBptMJojeXLCXyobnyog4YhzXYvmCFi6qVSfaeRdXdrfaU1areV5KykmX06rcvzumjY/1ggkR3Jh+bNf1mr8v1D5bLuvR3qDgFbvbBJYIrE1mCIoCrKxsHuzK+Rzvsi29+6DEbTZz9unijEYI8ObBgXOzlcrx9OAlXyDYKUCzwwrDQx1wVDGg089Dt+gR3mxmhcUnaWeoxwMbm/vzDFzmDEKMMNhquRqduT1KwXiGt0vre6iSeAUHNDE0d26NBtAXY9BACQyjFusKuL2Ry+IPb/Y9ZglwuVscdHaknUChqLF/O4jn3V5dP4mhgRJgwSYm+gV0Oi3XrvYB30yvhGa7BS70eGFHPoTJyQHhMK+F0ZesRVVznvXw5Ixv7/C10moEo6OZXbWvlFAF9FVZDOqEABUMRIkMd8GnLwVWg9/RkJF9sA4oDfYQAuzzjqzwvnaRUFxn/X2ZlmGLXAE7AL52B4xHgqAUqrC1nSNuoJkQtLkdqReszz/9aRvq90NOKdOS1nch8TpL555WDp49f3uAMXhACRjD5j4ykuCtf5PP7Fm1b0DIsl/VHGezzP1KwOiZQobFF9YyjSRYQETRENSlVzI8iK9mWlzckpSSCQHVALmN9Az1euDho9Xo8vKGd2rqooA8yBcrwHgCqYR0kMkWci08t/R+W4ljDCanWTg9TJGwGNaNk3vYZ7VUdeKsYJGFNkfSzjXNrSX20s4/h6kB81/271ghG17l+rPTAAAAAElFTkSuQmCC",
  "base64",
);

async function solid(width: number, height: number, format: "png" | "jpeg" | "webp" | "gif" = "png") {
  // A two-tone mark so the image is not blank.
  const base = sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } },
  }).composite([
    {
      input: await sharp({
        create: {
          width: Math.floor(width / 2),
          height: Math.floor(height / 2),
          channels: 4,
          background: { r: 250, g: 250, b: 250, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
      gravity: "centre",
    },
  ]);
  return base[format]().toBuffer();
}

/** GitHub's default avatar: 5 × 5 mirrored cells on #f0f0f0, 35 px margin of 420. */
async function identicon(size = 420) {
  const cell = 70;
  const fg = { r: 171, g: 61, b: 216 };
  const pattern = ["10101", "01110", "11011", "00100", "11011"];
  const overlays = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if (pattern[row]![col] !== "1") continue;
      overlays.push({
        input: await sharp({
          create: { width: cell, height: cell, channels: 3, background: fg },
        })
          .png()
          .toBuffer(),
        left: 35 + col * cell,
        top: 35 + row * cell,
      });
    }
  }
  const full = await sharp({
    create: { width: 420, height: 420, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .composite(overlays)
    .png()
    .toBuffer();
  return size === 420 ? full : sharp(full).resize(size, size).png().toBuffer();
}

describe("validateImage: accepted", () => {
  test.each(["png", "jpeg", "webp", "gif"] as const)("a 128 px %s decodes and is accepted", async (format) => {
    const bytes = await solid(128, 128, format);
    const verdict = await validateImage(bytes);
    expect(verdict).toMatchObject({ ok: true, width: 128, height: 128, format });
    if (verdict.ok) expect(verdict.sha256).toBe(sha256Hex(bytes));
  });

  test("a slightly non-square logo is accepted", async () => {
    expect(await validateImage(await solid(200, 170))).toMatchObject({ ok: true });
  });

  test("the PNG inside an ICO is extracted and validated", async () => {
    const png = await solid(128, 128);
    const header = Buffer.alloc(6 + 16);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = 0; // 0 = 256
    header[7] = 0;
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(header.length, 18);
    const verdict = await validateImage(Buffer.concat([header, png]));
    expect(verdict).toMatchObject({ ok: true, format: "png", width: 128 });
    if (verdict.ok) expect(verdict.sha256).toBe(sha256Hex(png));
  });
});

describe("validateImage: rejected", () => {
  test("empty, HTML and unknown bytes", async () => {
    expect(await validateImage(Buffer.alloc(0))).toMatchObject({ reason: "empty" });
    expect(
      await validateImage(Buffer.from("<!DOCTYPE html><html><body>Not found</body></html>")),
    ).toMatchObject({ reason: "not-an-image" });
    expect(await validateImage(Buffer.from("just some text"))).toMatchObject({
      reason: "unknown-format",
    });
  });

  test("SVG is recorded, never published", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>');
    expect(await validateImage(svg)).toMatchObject({ ok: false, reason: "svg-not-published" });
    const xml = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await validateImage(xml)).toMatchObject({ reason: "svg-not-published" });
  });

  test("a valid signature over garbage fails to decode", async () => {
    const png = await solid(128, 128);
    const truncated = png.subarray(0, Math.floor(png.length / 2));
    expect(await validateImage(truncated)).toMatchObject({ ok: false, reason: "decode-failed" });
    const bad = Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 7)]);
    expect(await validateImage(bad)).toMatchObject({ ok: false, reason: "decode-failed" });
  });

  test("a tiny image is too small, a banner is not square", async () => {
    expect(await validateImage(await solid(32, 32))).toMatchObject({ reason: "too-small", width: 32 });
    expect(await validateImage(await solid(63, 64))).toMatchObject({ reason: "too-small" });
    expect(await validateImage(await solid(400, 100))).toMatchObject({ reason: "not-square" });
  });

  test("decompression-heavy images are rejected from the header", async () => {
    const side = Math.ceil(Math.sqrt(MAX_ICON_PIXELS)) + 8;
    const heavy = await sharp({
      create: { width: side, height: side, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(heavy.length).toBeLessThan(200_000);
    expect(await validateImage(heavy)).toMatchObject({ ok: false, reason: expect.stringMatching(/too-many-pixels|decode-failed/) });
  });

  test("an animated image is rejected", async () => {
    // Two different frames stacked: identical frames would be merged into one.
    const red = await sharp({
      create: { width: 80, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).raw().toBuffer();
    const blue = await sharp({
      create: { width: 80, height: 80, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
    }).raw().toBuffer();
    const frame = Buffer.concat([red, blue]);
    const animated = await sharp(frame, { raw: { width: 80, height: 160, channels: 4, pageHeight: 80 } })
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect(await validateImage(animated)).toMatchObject({ ok: false, reason: "animated" });
  });

  test("a blank image is rejected", async () => {
    const blank = await sharp({
      create: { width: 128, height: 128, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    expect(await validateImage(blank)).toMatchObject({ reason: "blank-image" });
  });

  test("the favicon services' default globes are known defaults", async () => {
    expect(KNOWN_DEFAULT_IMAGE_HASHES.has(sha256Hex(GOOGLE_GLOBE))).toBe(true);
    expect(await validateImage(GOOGLE_GLOBE)).toMatchObject({
      ok: false,
      reason: "known-default-image",
    });
  });

  test("a GitHub default identicon is rejected, at any served size", async () => {
    for (const size of [420, 128]) {
      expect(await validateImage(await identicon(size))).toMatchObject({
        ok: false,
        reason: "github-identicon",
      });
    }
  });

  test("a symmetric logo on the same pale field is not mistaken for an identicon", async () => {
    const logo = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 120, height: 120, channels: 3, background: { r: 10, g: 120, b: 80 } },
          })
            .png()
            .toBuffer(),
          gravity: "centre",
        },
      ])
      .png()
      .toBuffer();
    expect(await validateImage(logo)).toMatchObject({ ok: true });
  });
});

describe("looksLikeGithubIdenticon", () => {
  test("needs the margin, one colour and mirror symmetry", () => {
    const side = 60;
    const rgba = Buffer.alloc(side * side * 4, 255);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 240;
    }
    // No filled cells: not an identicon.
    expect(looksLikeGithubIdenticon(rgba, side)).toBe(false);
  });
});
