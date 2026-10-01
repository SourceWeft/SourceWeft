/** Entry kinds: regular file, directory, symbolic link. Hard links are stored as independent files. */
export type EntryKind = "f" | "d" | "l";

/** One path's final state in a manifest (no rename opcode: replay is idempotent). */
export type ManifestEntry = {
  /** Relative path under the volume root, `/`-separated, never starting with `.sourceweft`. */
  p: string;
  k: EntryKind;
  /** Permission bits (0..0o7777). */
  m: number;
  /** mtime in nanoseconds since the epoch, as a decimal string (exceeds 2^53). */
  t?: string;
  /** File size in bytes (files only). */
  s?: number;
  /** Symlink target (links only). */
  l?: string;
  /** Chunk list: [blake3 hex, raw length] pairs in file order (files only). */
  c?: Array<[string, number]>;
};

/** Where a chunk lives: pack key relative to the volume prefix, offset, compressed length, raw length. */
export type ChunkLocation = [
  pack: string,
  off: number,
  clen: number,
  rlen: number,
];

export type Manifest = {
  v: number;
  volume: string;
  attachment: string;
  boot_id?: string;
  seq: number;
  base: number;
  trigger?: string;
  /** A self-contained snapshot: lists every entry and every chunk location it uses; unlisted paths do not exist. */
  full?: boolean;
  upserts?: ManifestEntry[];
  deletes?: string[];
  /** Chunks introduced by this manifest. */
  chunks?: Record<string, ChunkLocation>;
  /** Packs this manifest relies on: [key, size]. */
  packs?: Array<[string, number]>;
  unstable?: string[];
  skipped?: string[];
  ts_ms?: number;
};

export type PlanEntry = {
  p: string;
  k: EntryKind;
  m: number;
  /** nanoseconds, decimal string */
  t: string;
  s: number;
  l: string | null;
  c: Array<[string, number]>;
};

/** What the helper needs to restore or lazily serve a volume: entries, chunk locations and a GET URL per pack. */
export type RestorePlan = {
  volume: string;
  attachment: string;
  seq: number;
  entries: PlanEntry[];
  chunks: Record<string, ChunkLocation>;
  packs: Record<string, string>;
};

/** Write-once upload slots for one attachment epoch. */
export type SlotSet = {
  volume: string;
  attachment: string;
  pack_prefix: string;
  manifest_prefix: string;
  /** pack index (as a string) -> pre-signed PUT URL */
  packs: Record<string, string>;
  /** manifest seq (as a string) -> pre-signed PUT URL */
  manifests: Record<string, string>;
};

/** The JSON the helper prints after `flush`. Only the fields the host reads are typed. */
export type FlushReport = {
  ok?: boolean;
  seq?: number;
  ms?: number;
  scanned?: number;
  upserts?: number;
  deletes?: number;
  bytes_read?: number;
  bytes_uploaded?: number;
  packs?: number;
  reason?: string;
  unreadable?: string[];
  error?: string;
  [key: string]: unknown;
};

/** Result of stripping the wrapper's tail marker from a command's output. */
export type ParsedCommandOutput = {
  /** The user command's own output, marker removed. */
  output: string;
  /** Exit code of `swvol flush` (or 75 when the container identity check failed); null when no marker was found. */
  flushExitCode: number | null;
  flush: FlushReport | null;
  /** True when the wrapper refused to run the command because the container was replaced. */
  instanceChanged: boolean;
  markerFound: boolean;
};
