import {
  MAX_CHUNK_RAW_BYTES,
  MAX_CHUNK_COMPRESSED_BYTES,
  MAX_FILE_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_SYMLINK_TARGET_BYTES,
  PROTOCOL_VERSION,
} from "./constants";
import { ManifestRejected } from "./manifest";
import { isValidVolumePath, isWellFormedUnicode } from "./paths";
import type { ChunkLocation, Manifest, ManifestEntry } from "./types";

const CHUNK_ID = /^[0-9a-f]{64}$/;
const PACK_NAME = /^\d{6}$/;

/** What the validator needs from the authoritative store. All lookups are by this attachment's volume. */
export type ValidationContext = {
  volumeId: string;
  attachmentId: string;
  /** Current head sequence number of the volume. */
  head: number;
  bootId?: string | null;
  slotsUntilPack?: number;
  slotsUntilSeq?: number;
  /** Authoritative raw chunk length, used to reject inconsistent file extents. */
  chunkLength?(id: string): Promise<number | null>;
  /** Key prefix of this attachment's packs, relative to the volume prefix: `att/<id>/p/`. */
  packPrefix: string;
  /** Key of the manifest object being validated (inline chunks point at it). */
  ownKey: string;
  rawLength: number;
  inlineRange: [number, number];
  /** True when the chunk id is already recorded for this volume. */
  chunkKnown(id: string): Promise<boolean>;
  /** Size of a pack object in the bucket, or null when it does not exist. */
  packSize(key: string): Promise<number | null>;
};

export type ValidatedManifest = {
  manifest: Manifest;
  /** Pack key -> size, for every pack referenced by chunks introduced here (the manifest's own key for inline chunks). */
  packSizes: Map<string, number>;
  /** Chunks that are genuinely new to the volume (a snapshot repeats known ones; those are dropped here). */
  newChunks: Record<string, ChunkLocation>;
};

function reject(message: string): never {
  throw new ManifestRejected(message);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * The 18 checks from the prototype, in the same order. Every failure is a rejection of the whole
 * manifest; the chain stops at this seq and the attachment has to be rebuilt (epoch + 1).
 */
export async function validateManifest(
  manifest: Manifest,
  ctx: ValidationContext,
): Promise<ValidatedManifest> {
  if (
    manifest.v !== PROTOCOL_VERSION ||
    manifest.volume !== ctx.volumeId ||
    manifest.attachment !== ctx.attachmentId
  ) {
    reject("identity mismatch");
  }
  if (ctx.bootId != null && manifest.boot_id !== ctx.bootId)
    reject("boot identity mismatch");
  if (
    !isInt(manifest.seq) ||
    !isInt(manifest.base) ||
    manifest.seq !== ctx.head + 1 ||
    manifest.base !== ctx.head
  ) {
    reject(
      `sequence gap: head=${ctx.head} seq=${manifest.seq} base=${manifest.base}`,
    );
  }
  if (ctx.slotsUntilSeq !== undefined && manifest.seq > ctx.slotsUntilSeq)
    reject("manifest sequence has no issued slot");
  if (manifest.full !== undefined && typeof manifest.full !== "boolean")
    reject("invalid full flag");
  for (const field of ["upserts", "deletes", "unstable", "skipped"] as const) {
    if (manifest[field] !== undefined && !Array.isArray(manifest[field]))
      reject(`invalid ${field} array`);
  }
  if (
    manifest.chunks !== undefined &&
    (!manifest.chunks ||
      typeof manifest.chunks !== "object" ||
      Array.isArray(manifest.chunks))
  )
    reject("invalid chunks object");
  const upserts = Array.isArray(manifest.upserts) ? manifest.upserts : [];
  const deletes = Array.isArray(manifest.deletes) ? manifest.deletes : [];
  if (upserts.length + deletes.length > MAX_MANIFEST_ENTRIES) {
    reject("too many entries");
  }
  const declared =
    manifest.chunks &&
    typeof manifest.chunks === "object" &&
    !Array.isArray(manifest.chunks)
      ? manifest.chunks
      : {};
  const newChunks: Record<string, ChunkLocation> = {};
  for (const [id, location] of Object.entries(declared)) {
    if (manifest.full && CHUNK_ID.test(id) && (await ctx.chunkKnown(id)))
      continue; // the host's own record stands
    newChunks[id] = location;
  }
  const packSizes = new Map<string, number>();
  for (const [id, location] of Object.entries(newChunks)) {
    if (
      !CHUNK_ID.test(id) ||
      !Array.isArray(location) ||
      location.length !== 4
    ) {
      reject("malformed chunk record");
    }
    const [pack, off, clen, rlen] = location;
    if (
      !isInt(off) ||
      !isInt(clen) ||
      !isInt(rlen) ||
      off < 0 ||
      clen <= 0 ||
      rlen <= 0 ||
      rlen > MAX_CHUNK_RAW_BYTES ||
      clen > MAX_CHUNK_COMPRESSED_BYTES ||
      !Number.isSafeInteger(off + clen)
    ) {
      reject("chunk bounds");
    }
    if (pack === ctx.ownKey) {
      const [lo, hi] = ctx.inlineRange;
      if (off < lo || off + clen > hi)
        reject("inline chunk lies outside the manifest's inline section");
      packSizes.set(pack, ctx.rawLength);
      continue;
    }
    if (
      typeof pack !== "string" ||
      !pack.startsWith(ctx.packPrefix) ||
      !PACK_NAME.test(pack.slice(ctx.packPrefix.length))
    ) {
      reject(
        `chunk points outside this attachment's packs: ${String(pack).slice(0, 80)}`,
      );
    }
    if (
      ctx.slotsUntilPack !== undefined &&
      Number(pack.slice(ctx.packPrefix.length)) >= ctx.slotsUntilPack
    )
      reject("pack has no issued slot");
    let size = packSizes.get(pack);
    if (size === undefined) {
      const found = await ctx.packSize(pack);
      if (found === null)
        reject(`referenced pack is not in the bucket: ${pack}`);
      size = found;
      packSizes.set(pack, size);
    }
    if (off + clen > size) reject("chunk extends past the end of its pack");
  }
  const known = async (id: string) =>
    id in newChunks || (await ctx.chunkKnown(id));
  const paths = new Map<string, ManifestEntry>();
  for (const entry of upserts) {
    validateEntryShape(entry);
    if (paths.has(entry.p)) reject("duplicate upsert path");
    paths.set(entry.p, entry);
  }
  for (const entry of upserts) {
    let parent = entry.p;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (paths.has(parent) && paths.get(parent)!.k !== "d")
        reject("entry parent is not a directory");
    }
    if (entry.k === "f") {
      const size = entry.s;
      if (!isInt(size) || size < 0 || size > MAX_FILE_BYTES)
        reject("invalid size");
      let total = 0;
      for (const chunk of entry.c ?? []) {
        if (
          !Array.isArray(chunk) ||
          chunk.length !== 2 ||
          typeof chunk[0] !== "string" ||
          !isInt(chunk[1]) ||
          chunk[1] <= 0 ||
          chunk[1] > MAX_CHUNK_RAW_BYTES ||
          !CHUNK_ID.test(chunk[0]) ||
          !(await known(chunk[0]))
        ) {
          reject(`file ${JSON.stringify(entry.p)} references an unknown chunk`);
        }
        const authoritative =
          (ctx.chunkLength ? await ctx.chunkLength(chunk[0]) : undefined) ??
          newChunks[chunk[0]]?.[3];
        if (authoritative !== undefined && authoritative !== chunk[1])
          reject("file chunk length differs from recorded chunk");
        total += chunk[1];
        if (!Number.isSafeInteger(total)) reject("file chunk length overflow");
      }
      if (total !== size)
        reject(
          `file ${JSON.stringify(entry.p)}: chunk lengths do not add up to its size`,
        );
    }
  }
  const deleted = new Set<string>();
  for (const path of deletes) {
    if (deleted.has(path)) reject("duplicate delete path");
    deleted.add(path);
    if (!isValidVolumePath(path))
      reject(`invalid delete path ${JSON.stringify(path).slice(0, 80)}`);
  }
  return {
    manifest: { ...manifest, upserts, deletes, chunks: newChunks },
    packSizes,
    newChunks,
  };
}

function validateEntryShape(entry: ManifestEntry) {
  if (typeof entry !== "object" || entry === null) reject("malformed entry");
  if (!isValidVolumePath(entry.p))
    reject(`invalid path ${JSON.stringify(entry.p).slice(0, 80)}`);
  if (entry.k !== "f" && entry.k !== "d" && entry.k !== "l")
    reject("invalid kind");
  if (!isInt(entry.m) || entry.m < 0 || entry.m > 0o7777)
    reject("invalid mode");
  if (
    entry.t !== undefined &&
    !(typeof entry.t === "string" && /^-?\d{1,20}$/.test(entry.t))
  )
    reject("invalid mtime");
  if (entry.c !== undefined && !Array.isArray(entry.c))
    reject("invalid file chunks array");
  if (
    entry.k !== "f" &&
    ((entry.s !== undefined && entry.s !== 0) ||
      (entry.c !== undefined && entry.c.length !== 0))
  )
    reject("invalid entry shape for non-file");
  if (entry.k !== "l" && entry.l !== undefined && entry.l !== null)
    reject("invalid symlink target for non-symlink entry");
  if (
    entry.t !== undefined &&
    (BigInt(entry.t) > 9223372036854775807n ||
      BigInt(entry.t) < -9223372036854775808n)
  )
    reject("mtime exceeds database range");
  if (entry.k === "l") {
    const target = entry.l;
    if (
      typeof target !== "string" ||
      target.length === 0 ||
      !isWellFormedUnicode(target) ||
      Buffer.byteLength(target, "utf8") > MAX_SYMLINK_TARGET_BYTES ||
      target.includes("\0")
    ) {
      reject("invalid symlink target");
    }
  }
}
