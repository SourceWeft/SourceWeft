import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
  MANIFEST_HEADER_BYTES,
  MANIFEST_JSON_LIMIT_ERROR,
  MANIFEST_MAGIC,
  MAX_MANIFEST_JSON_BYTES,
} from "./constants";
import type { Manifest } from "./types";

export class ManifestRejected extends Error {
  override readonly name = "ManifestRejected";
}

export type ParsedManifest = {
  manifest: Manifest;
  /** Byte range [start, end) of the inline chunk section inside the object. */
  inlineRange: [number, number];
  rawLength: number;
};

/**
 * Object layout: `SWVOLM1\n` | u64 LE inline length | inline chunk bytes | zstd(JSON).
 * Anything that does not parse is a rejection, never an exception: the sandbox is untrusted.
 */
export function parseManifestObject(raw: Uint8Array): ParsedManifest {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (
    buf.length < MANIFEST_HEADER_BYTES ||
    buf.subarray(0, 8).toString("latin1") !== MANIFEST_MAGIC
  ) {
    throw new ManifestRejected("bad manifest header");
  }
  const inlineLength = Number(buf.readBigUInt64LE(8));
  if (
    !Number.isSafeInteger(inlineLength) ||
    MANIFEST_HEADER_BYTES + inlineLength > buf.length
  ) {
    throw new ManifestRejected("inline section longer than the object");
  }
  const bodyStart = MANIFEST_HEADER_BYTES + inlineLength;
  let json: unknown;
  try {
    const body = zstdDecompressSync(buf.subarray(bodyStart), {
      maxOutputLength: MAX_MANIFEST_JSON_BYTES,
    });
    json = JSON.parse(body.toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("maxOutputLength") ||
      message.includes("Cannot create a Buffer larger")
    ) {
      throw new ManifestRejected(MANIFEST_JSON_LIMIT_ERROR);
    }
    throw new ManifestRejected(
      `unparseable manifest body: ${message.slice(0, 80)}`,
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ManifestRejected("manifest is not an object");
  }
  return {
    manifest: json as Manifest,
    inlineRange: [MANIFEST_HEADER_BYTES, bodyStart],
    rawLength: buf.length,
  };
}

/** Encode a manifest the way the helper does (used by tests and by host-generated snapshots). */
export function encodeManifestObject(
  manifest: Manifest,
  inline: Uint8Array = new Uint8Array(0),
): Buffer {
  const header = Buffer.alloc(MANIFEST_HEADER_BYTES);
  header.write(MANIFEST_MAGIC, 0, "latin1");
  header.writeBigUInt64LE(BigInt(inline.byteLength), 8);
  const body = zstdCompressSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  return Buffer.concat([header, Buffer.from(inline), body]);
}
