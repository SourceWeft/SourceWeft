import {
  MAX_CHUNK_RAW_BYTES,
  MAX_CHUNK_COMPRESSED_BYTES,
  MAX_PACK_OBJECT_BYTES,
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
 * Complete metadata/ownership preflight precedes object I/O. At most four unique
 * pack HEADs run together; every started request settles before validation fails.
 * Transport failures remain retryable, while invalid metadata rejects the manifest.
 */
export async function validateManifest(
  manifest: Manifest,
  ctx: ValidationContext,
): Promise<ValidatedManifest> {
  // Keep the checked metadata stable across asynchronous authoritative lookups.
  manifest = { ...manifest };
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
  const upserts = Array.isArray(manifest.upserts)
    ? manifest.upserts.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        return {
          ...entry,
          ...(Array.isArray(entry.c)
            ? {
                c: entry.c.map((pair) =>
                  Array.isArray(pair) && pair.length === 2
                    ? ([pair[0], pair[1]] as [string, number])
                    : pair,
                ),
              }
            : {}),
        };
      })
    : [];
  const deletes = Array.isArray(manifest.deletes) ? [...manifest.deletes] : [];
  if (upserts.length + deletes.length > MAX_MANIFEST_ENTRIES) {
    reject("too many entries");
  }
  const declared =
    manifest.chunks &&
    typeof manifest.chunks === "object" &&
    !Array.isArray(manifest.chunks)
      ? manifest.chunks
      : {};
  // Snapshot every tuple before chunkKnown can yield. Five retained elements
  // suffice to keep overlong arrays invalid without duplicating unbounded input.
  const declaredLocations = Object.entries(declared).map(
    ([id, location]) =>
      [id, Array.isArray(location) ? location.slice(0, 5) : location] as const,
  );
  const newChunks: Record<string, ChunkLocation> = {};
  for (const [id, location] of declaredLocations) {
    // Check before assigning into a JS record: __proto__ must never install inherited chunks.
    if (!CHUNK_ID.test(id)) reject("malformed chunk record");
    if (manifest.full && (await ctx.chunkKnown(id))) continue; // the host's own record stands
    if (!Array.isArray(location) || location.length !== 4)
      reject("malformed chunk record");
    // This private snapshot is length-checked here; primitive bounds are checked below.
    newChunks[id] = location as ChunkLocation;
  }
  const packSizes = new Map<string, number>();
  const packEnds = new Map<string, number>();
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
        `chunk points outside this attachment's packs: ${typeof pack === "string" ? pack.slice(0, 80) : "non-string key"}`,
      );
    }
    if (
      ctx.slotsUntilPack !== undefined &&
      Number(pack.slice(ctx.packPrefix.length)) >= ctx.slotsUntilPack
    )
      reject("pack has no issued slot");
    if (off + clen > MAX_PACK_OBJECT_BYTES)
      reject("chunk bounds exceed the external pack limit");
    packEnds.set(pack, Math.max(packEnds.get(pack) ?? 0, off + clen));
  }
  const known = async (id: string) =>
    Object.hasOwn(newChunks, id) || (await ctx.chunkKnown(id));
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
  // Only fully checked actor-owned keys reach the callback. Cache the Promise,
  // not just its result, so repeated chunks can never schedule duplicate HEADs.
  const inFlight = new Map<string, Promise<number>>();
  const keys = [...packEnds.keys()];
  const failures = new Map<number, unknown>();
  let cursor = 0;
  const lookup = (key: string): Promise<number> => {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const size = await ctx.packSize(key);
        if (size === null)
          reject(`referenced pack is not in the bucket: ${key}`);
        if (!isInt(size) || size < 1 || size > MAX_PACK_OBJECT_BYTES)
          reject("invalid external pack size");
        if (packEnds.get(key)! > size)
          reject("chunk extends past the end of its pack");
        return size;
      });
      inFlight.set(key, pending);
    }
    return pending;
  };
  const workers = Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (!failures.size && cursor < keys.length) {
      const index = cursor++,
        key = keys[index]!;
      try {
        packSizes.set(key, await lookup(key));
      } catch (error) {
        failures.set(index, error);
      }
    }
  });
  // Do not abort peers after the first error: preserve all outcomes of requests
  // already issued, while not scheduling more work after failure is observed.
  const settled = await Promise.allSettled(workers);
  for (const [index, result] of settled.entries())
    if (result.status === "rejected")
      failures.set(keys.length + index, result.reason);
  const errors = [...failures.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, error]) => error);
  if (errors.length === 1) {
    if (errors[0] instanceof Error) throw errors[0];
    throw new AggregateError(errors, "pack HEAD verification failed");
  }
  if (errors.length > 1) {
    const aggregate = new AggregateError(
      errors,
      "pack HEAD verification failed",
    );
    if (errors.every((error) => error instanceof ManifestRejected))
      throw new ManifestRejected((errors[0] as ManifestRejected).message, {
        cause: aggregate,
      });
    throw aggregate; // Mixed or unknown infrastructure failures must not force a permanent WAL rejection.
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
