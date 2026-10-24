import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Deterministic validation of a fetched icon candidate before it is stored
 * (Issue #367 dry-run): byte signature and a successful decode, at least 64 px
 * and near-square, bounded pixels and frames, not a known default image, not
 * a GitHub identicon, not blank. Raw SVG and mask icons are never published
 * in this version; they are recorded as rejected. Everything here is a pure
 * function of the bytes; whether the SITE the bytes came from is parked or a
 * challenge page is decided by the caller from the page itself.
 */

export const MIN_ICON_SIDE = 64;
/** The longer side may exceed the shorter by at most this factor. */
export const MAX_ICON_ASPECT = 1.25;
/** Decode budget: 4096 × 4096 pixels, one frame. */
export const MAX_ICON_PIXELS = 4096 * 4096;

export type ImageRejection =
  | "empty"
  | "not-an-image"
  | "unknown-format"
  | "svg-not-published"
  | "mask-icon-not-published"
  | "ico-unsupported"
  | "decode-failed"
  | "too-many-pixels"
  | "animated"
  | "too-small"
  | "not-square"
  | "known-default-image"
  | "github-identicon"
  | "blank-image";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";

export type ImageVerdict =
  | {
      ok: true;
      sha256: string;
      width: number;
      height: number;
      format: ImageFormat;
      contentType: string;
      /** The bytes to store: the input, or the PNG inside an ICO. */
      bytes: Buffer;
    }
  | {
      ok: false;
      reason: ImageRejection;
      sha256?: string;
      width?: number;
      height?: number;
    };

/** Default images the favicon services answer with for an unknown site. */
export const KNOWN_DEFAULT_IMAGE_HASHES: ReadonlyMap<string, string> = new Map([
  [
    "59bfe9bc385ad69f50793ce4a53397316d7a875a7148a63c16df9b674c6cda64",
    "google-globe",
  ],
  [
    "e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17",
    "duckduckgo-globe",
  ],
]);

const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
export const IMAGE_EXTENSIONS: Record<ImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
};

export const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Sniffed =
  | { kind: "raster"; format: ImageFormat }
  | { kind: "ico" }
  | { kind: "svg" }
  | { kind: "html" }
  | { kind: "unknown" };

function sniff(bytes: Buffer): Sniffed {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { kind: "raster", format: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "raster", format: "jpeg" };
  }
  const head6 = bytes.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    return { kind: "raster", format: "gif" };
  }
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { kind: "raster", format: "webp" };
  }
  if (
    bytes.length >= 6 &&
    bytes.readUInt16LE(0) === 0 &&
    bytes.readUInt16LE(2) === 1 &&
    bytes.readUInt16LE(4) > 0
  ) {
    return { kind: "ico" };
  }
  const text = bytes.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
    return { kind: "svg" };
  }
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<head")) {
    return { kind: "html" };
  }
  return { kind: "unknown" };
}

/** The largest PNG image stored inside an ICO container, if there is one. */
function pngInsideIco(bytes: Buffer): Buffer | undefined {
  const count = bytes.readUInt16LE(4);
  let best: { side: number; data: Buffer } | undefined;
  for (let i = 0; i < Math.min(count, 64); i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > bytes.length) break;
    const side = Math.max(bytes[at]! || 256, bytes[at + 1]! || 256);
    const size = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    if (offset + size > bytes.length || size < PNG_SIGNATURE.length) continue;
    const data = bytes.subarray(offset, offset + size);
    if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) continue;
    if (!best || side > best.side) best = { side, data };
  }
  return best?.data;
}

const IDENTICON_BACKGROUND = 240;
const near = (a: number, b: number, tolerance: number) =>
  Math.abs(a - b) <= tolerance;

/**
 * GitHub's default avatar: a 5 × 5 grid, mirrored left to right, in one colour
 * on a #f0f0f0 field with a margin of one sixth of a cell all round. `rgba` is
 * the image squashed to `side` × `side`.
 */
export function looksLikeGithubIdenticon(
  rgba: Buffer,
  side: number,
): boolean {
  const at = (x: number, y: number) => {
    const i = (y * side + x) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!] as const;
  };
  const isBackground = (x: number, y: number) => {
    const [r, g, b, a] = at(x, y);
    return (
      a > 250 &&
      near(r, IDENTICON_BACKGROUND, 4) &&
      near(g, IDENTICON_BACKGROUND, 4) &&
      near(b, IDENTICON_BACKGROUND, 4)
    );
  };
  // The margin strip all round is background.
  const margin = Math.max(1, Math.floor(side * 0.04));
  for (let i = 0; i < side; i += 1) {
    for (let m = 0; m < margin; m += 1) {
      if (
        !isBackground(i, m) ||
        !isBackground(i, side - 1 - m) ||
        !isBackground(m, i) ||
        !isBackground(side - 1 - m, i)
      ) {
        return false;
      }
    }
  }
  // Cell centres sit at (i + 1) / 6 of the side.
  const cells: Array<ReadonlyArray<number> | "bg"> = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const x = Math.round(((col + 1) / 6) * side);
      const y = Math.round(((row + 1) / 6) * side);
      cells.push(isBackground(x, y) ? "bg" : at(x, y));
    }
  }
  let foreground: ReadonlyArray<number> | undefined;
  let filled = 0;
  for (const cell of cells) {
    if (cell === "bg") continue;
    filled += 1;
    foreground ??= cell;
    if (
      !near(cell[0]!, foreground[0]!, 14) ||
      !near(cell[1]!, foreground[1]!, 14) ||
      !near(cell[2]!, foreground[2]!, 14)
    ) {
      return false;
    }
  }
  if (!foreground || filled < 3 || filled > 22) return false;
  // Mirror symmetry: column 0 ≡ 4 and 1 ≡ 3 in every row.
  for (let row = 0; row < 5; row += 1) {
    const isBg = (col: number) => cells[row * 5 + col] === "bg";
    if (isBg(0) !== isBg(4) || isBg(1) !== isBg(3)) return false;
  }
  // The cells must also have the identicon's geometry: each spans a sixth of
  // the image between margins of a twelfth, so rebuilding the picture from
  // the 5 × 5 reading has to reproduce it. (A centred, symmetric logo reads
  // like a grid too, but its edges are not on the cell boundaries.)
  const expectedFg = (x: number, y: number) => {
    const col = Math.floor(((x + 0.5) / side - 1 / 12) * 6);
    const row = Math.floor(((y + 0.5) / side - 1 / 12) * 6);
    return col >= 0 && col < 5 && row >= 0 && row < 5 && cells[row * 5 + col] !== "bg";
  };
  let compared = 0;
  let matching = 0;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const fgHere = expectedFg(x, y);
      // Pixels next to a cell edge are blurred by resampling: not compared.
      if (
        (x > 0 && expectedFg(x - 1, y) !== fgHere) ||
        (x < side - 1 && expectedFg(x + 1, y) !== fgHere) ||
        (y > 0 && expectedFg(x, y - 1) !== fgHere) ||
        (y < side - 1 && expectedFg(x, y + 1) !== fgHere)
      ) {
        continue;
      }
      compared += 1;
      const [r, g, b] = at(x, y);
      const expected = fgHere ? foreground : [240, 240, 240];
      const tolerance = fgHere ? 24 : 10;
      if (
        near(r, expected[0]!, tolerance) &&
        near(g, expected[1]!, tolerance) &&
        near(b, expected[2]!, tolerance)
      ) {
        matching += 1;
      }
    }
  }
  return compared > 0 && matching / compared >= 0.97;
}

function isBlank(rgba: Buffer) {
  const min = [255, 255, 255, 255];
  const max = [0, 0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 4; c += 1) {
      const v = rgba[i + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }
  return [0, 1, 2, 3].every((c) => max[c]! - min[c]! <= 2);
}

const SAMPLE_SIDE = 60;

/** Check `input` and, if it is acceptable, return what to store and record. */
export async function validateImage(input: Buffer): Promise<ImageVerdict> {
  if (input.length === 0) return { ok: false, reason: "empty" };
  const kind = sniff(input);
  if (kind.kind === "svg") {
    return { ok: false, reason: "svg-not-published", sha256: sha256Hex(input) };
  }
  if (kind.kind === "html") return { ok: false, reason: "not-an-image" };
  if (kind.kind === "unknown") return { ok: false, reason: "unknown-format" };

  let bytes = input;
  let format: ImageFormat;
  if (kind.kind === "ico") {
    const png = pngInsideIco(input);
    if (!png) {
      return { ok: false, reason: "ico-unsupported", sha256: sha256Hex(input) };
    }
    bytes = Buffer.from(png);
    format = "png";
  } else {
    format = kind.format;
  }
  const sha256 = sha256Hex(bytes);
  const known = KNOWN_DEFAULT_IMAGE_HASHES.get(sha256);

  let width: number;
  let height: number;
  let sample: Buffer;
  try {
    const image = sharp(bytes, {
      limitInputPixels: MAX_ICON_PIXELS,
      failOn: "error",
    });
    const meta = await image.metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    if (!width || !height) return { ok: false, reason: "decode-failed", sha256 };
    if (width * height > MAX_ICON_PIXELS) {
      return { ok: false, reason: "too-many-pixels", sha256, width, height };
    }
    if ((meta.pages ?? 1) > 1) {
      return { ok: false, reason: "animated", sha256, width, height };
    }
    sample = await image
      .resize(SAMPLE_SIDE, SAMPLE_SIDE, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer();
  } catch {
    return { ok: false, reason: "decode-failed", sha256 };
  }
  if (known) return { ok: false, reason: "known-default-image", sha256, width, height };
  if (Math.min(width, height) < MIN_ICON_SIDE) {
    return { ok: false, reason: "too-small", sha256, width, height };
  }
  if (Math.max(width, height) / Math.min(width, height) > MAX_ICON_ASPECT) {
    return { ok: false, reason: "not-square", sha256, width, height };
  }
  if (looksLikeGithubIdenticon(sample, SAMPLE_SIDE)) {
    return { ok: false, reason: "github-identicon", sha256, width, height };
  }
  if (isBlank(sample)) {
    return { ok: false, reason: "blank-image", sha256, width, height };
  }
  return {
    ok: true,
    sha256,
    width,
    height,
    format,
    contentType: CONTENT_TYPES[format],
    bytes,
  };
}
