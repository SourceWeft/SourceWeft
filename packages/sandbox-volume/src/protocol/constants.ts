/** Wire-level constants shared with the helper. Change PROTOCOL_VERSION only for wire-format changes; helper/VERSION also tracks implementation qualification. */
export const PROTOCOL_VERSION = 1;

/** Magic prefix of a manifest object: `SWVOLM1\n` | u64 little-endian inline length | inline chunk bytes | zstd(JSON). */
export const MANIFEST_MAGIC = "SWVOLM1\n";
export const MANIFEST_HEADER_BYTES = 16;

/** Printed by the command wrapper on its own line at the end of stdout: `__SWVOL__ <flush exit code> <json>`. */
export const TAIL_MARKER = "__SWVOL__";

/** Helper exit codes that the host reacts to. */
export const EXIT_INSTANCE_CHANGED = 75;
export const EXIT_NEED_SLOTS = 76;
export const EXIT_PACK_UNREADABLE = 77;
export const EXIT_NO_SPACE = 78;

/** Limits applied when a manifest is validated. */
export const MAX_MANIFEST_ENTRIES = 200_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
/** Match swvol CDC_MAX and swvol-core decode bounds; larger chunks cannot be restored. */
export const MAX_CHUNK_RAW_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_PATH_COMPONENT_BYTES = 255;
export const MAX_PATH_BYTES = 4096;
/** Linux symlinkat accepts at most PATH_MAX-1 bytes; 4096 cannot be restored. */
export const MAX_SYMLINK_TARGET_BYTES = 4095;
export const MAX_MANIFEST_JSON_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_INLINE_BYTES = 4 * 1024 * 1024;
/** Existing JSON budget + zstd worst-case overhead and the helper's <=4 MiB inline pack.
 * This bounds download memory before decompression; it is not a claim of low peak RSS.
 */
export const MAX_MANIFEST_OBJECT_BYTES =
  MAX_MANIFEST_JSON_BYTES + 8 * 1024 * 1024;

/** Slots handed to a sandbox per issue: write-once pre-signed PUT URLs. */
export const PACK_SLOTS_PER_ISSUE = 64;
export const MANIFEST_SLOTS_PER_ISSUE = 64;
export const PRESIGN_TTL_SECONDS = 3600;

export const MANIFEST_JSON_LIMIT_ERROR = "manifest body exceeds the size limit";
