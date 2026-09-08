/**
 * Shared kernel for artifact file naming, MIME/extension resolution, and size
 * limits.
 *
 * Before this module the same three decisions were re-implemented in six
 * different packages, and the implementations had drifted: the title
 * `"Résumé Q3"` landed on disk as `Résumé Q3`, `r-sum-q3`, `R-sum-Q3`, or
 * `Résumé-Q3` depending on which capability published it, and MIME sniffing was
 * done with substring matching in two places (so `application/x-gif-thing` was
 * classified as a GIF). Everything here is pure data plus pure functions, which
 * is why it lives in `contracts` rather than in any one capability package.
 *
 * The divergences that were collapsed are pinned as explicit cases in
 * `tests/artifact-files.test.ts` — that file is the documentation of record for
 * what changed and what each old implementation used to answer.
 */

/* -------------------------------------------------------------------------- */
/* File name / storage segment sanitizing                                      */
/* -------------------------------------------------------------------------- */

export type SanitizeFileBaseOptions = {
  /** Returned when sanitizing leaves nothing usable. */
  readonly fallback?: string;
  /** Maximum length of the sanitized base, before any extension is appended. */
  readonly maxLength?: number;
};

const DEFAULT_FILE_BASE_FALLBACK = "artifact";
const DEFAULT_FILE_BASE_MAX_LENGTH = 120;
const DEFAULT_STORAGE_SEGMENT_MAX_LENGTH = 80;

/**
 * Characters that are hostile in a file name on at least one supported target
 * (Windows reserved set, POSIX separators, and `%` because these names also end
 * up inside URL paths and storage keys).
 */
const FILE_NAME_HOSTILE_PATTERN = /[\u0000-\u001f\u007f<>:"/\\|?*%]+/g;

/** Everything that is not safe as a bare ASCII path segment. */
const NON_ASCII_SEGMENT_PATTERN = /[^A-Za-z0-9._-]+/g;

function collapseAndTrim(value: string, maxLength: number, fallback: string) {
  const collapsed = value
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, maxLength)
    // Slicing can leave a trailing separator behind; strip it again so the
    // truncated name never ends in `-` or `.`.
    .replace(/[\s.-]+$/g, "");
  return collapsed.length > 0 ? collapsed : fallback;
}

/**
 * Canonical name for a downloaded/displayed artifact file, minus its extension.
 *
 * Unicode is deliberately preserved: a Japanese or accented title keeps its
 * letters instead of decaying into a row of dashes. Two things make that safe —
 * `Content-Disposition` is always emitted as `filename*=UTF-8''<percent-encoded>`
 * (see `apps/backend/src/api/routes/content/*.ts`), and storage keys built from
 * these names get a second ASCII-only pass in
 * `apps/backend/src/modules/sources/storage.ts`. Neither the header nor the
 * object key ever sees a raw non-ASCII byte.
 *
 * Whitespace collapses to `-` rather than being preserved, so names are safe to
 * paste into shells and URLs without quoting.
 */
export function sanitizeArtifactFileBase(
  value: string,
  options: SanitizeFileBaseOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FILE_BASE_FALLBACK;
  const maxLength = options.maxLength ?? DEFAULT_FILE_BASE_MAX_LENGTH;
  const normalized = value
    .normalize("NFKC")
    .replace(FILE_NAME_HOSTILE_PATTERN, "-")
    .replace(/\s+/g, "-");
  return collapseAndTrim(normalized, maxLength, fallback);
}

/**
 * ASCII-only variant, for values that become shell paths, sandbox directory
 * names, job ids, or raw storage keys — contexts where a non-ASCII byte is a
 * real hazard rather than a cosmetic one. Use
 * {@link sanitizeArtifactFileBase} for anything a user downloads or sees.
 */
export function sanitizeArtifactStorageSegment(
  value: string,
  options: SanitizeFileBaseOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FILE_BASE_FALLBACK;
  const maxLength = options.maxLength ?? DEFAULT_STORAGE_SEGMENT_MAX_LENGTH;
  const normalized = value
    .normalize("NFKC")
    .replace(NON_ASCII_SEGMENT_PATTERN, "-");
  return collapseAndTrim(normalized, maxLength, fallback);
}

/* -------------------------------------------------------------------------- */
/* MIME types and extensions                                                   */
/* -------------------------------------------------------------------------- */

export const ARTIFACT_MIME_TYPES = {
  aac: "audio/aac",
  avif: "image/avif",
  binary: "application/octet-stream",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  flac: "audio/flac",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  json: "application/json",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  text: "text/plain",
  wav: "audio/wav",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
} as const;

export type ArtifactMimeType =
  (typeof ARTIFACT_MIME_TYPES)[keyof typeof ARTIFACT_MIME_TYPES];

/**
 * Extension -> MIME. Several extensions can map to one MIME type (`.jpg` and
 * `.jpeg`); the reverse direction picks a single canonical extension below.
 */
const MIME_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".aac", ARTIFACT_MIME_TYPES.aac],
  [".avif", ARTIFACT_MIME_TYPES.avif],
  [".bin", ARTIFACT_MIME_TYPES.binary],
  [".csv", ARTIFACT_MIME_TYPES.csv],
  [".docx", ARTIFACT_MIME_TYPES.docx],
  [".flac", ARTIFACT_MIME_TYPES.flac],
  [".gif", ARTIFACT_MIME_TYPES.gif],
  [".htm", ARTIFACT_MIME_TYPES.html],
  [".html", ARTIFACT_MIME_TYPES.html],
  [".jpeg", ARTIFACT_MIME_TYPES.jpeg],
  [".jpg", ARTIFACT_MIME_TYPES.jpeg],
  [".json", ARTIFACT_MIME_TYPES.json],
  [".md", ARTIFACT_MIME_TYPES.text],
  [".mp3", ARTIFACT_MIME_TYPES.mp3],
  [".opus", ARTIFACT_MIME_TYPES.opus],
  [".pdf", ARTIFACT_MIME_TYPES.pdf],
  [".png", ARTIFACT_MIME_TYPES.png],
  [".pptx", ARTIFACT_MIME_TYPES.pptx],
  [".svg", ARTIFACT_MIME_TYPES.svg],
  [".txt", ARTIFACT_MIME_TYPES.text],
  [".wav", ARTIFACT_MIME_TYPES.wav],
  [".webp", ARTIFACT_MIME_TYPES.webp],
  [".xlsx", ARTIFACT_MIME_TYPES.xlsx],
  [".zip", ARTIFACT_MIME_TYPES.zip],
]);

/**
 * MIME -> canonical extension, including a few non-canonical aliases seen in
 * the wild.
 *
 * `application/octet-stream` is deliberately absent: it means "no information",
 * so mapping it to `.bin` would override the fallback each caller chose for
 * exactly that case (an image tool wants `.png`, an audio tool wants `.mp3`).
 */
const EXTENSION_BY_MIME_TYPE: ReadonlyMap<string, string> = new Map([
  [ARTIFACT_MIME_TYPES.aac, ".aac"],
  [ARTIFACT_MIME_TYPES.avif, ".avif"],
  [ARTIFACT_MIME_TYPES.csv, ".csv"],
  [ARTIFACT_MIME_TYPES.docx, ".docx"],
  [ARTIFACT_MIME_TYPES.flac, ".flac"],
  [ARTIFACT_MIME_TYPES.gif, ".gif"],
  [ARTIFACT_MIME_TYPES.html, ".html"],
  [ARTIFACT_MIME_TYPES.jpeg, ".jpg"],
  [ARTIFACT_MIME_TYPES.json, ".json"],
  [ARTIFACT_MIME_TYPES.mp3, ".mp3"],
  [ARTIFACT_MIME_TYPES.opus, ".opus"],
  [ARTIFACT_MIME_TYPES.pdf, ".pdf"],
  [ARTIFACT_MIME_TYPES.png, ".png"],
  [ARTIFACT_MIME_TYPES.pptx, ".pptx"],
  [ARTIFACT_MIME_TYPES.svg, ".svg"],
  [ARTIFACT_MIME_TYPES.text, ".txt"],
  [ARTIFACT_MIME_TYPES.wav, ".wav"],
  [ARTIFACT_MIME_TYPES.webp, ".webp"],
  [ARTIFACT_MIME_TYPES.xlsx, ".xlsx"],
  [ARTIFACT_MIME_TYPES.zip, ".zip"],
  // Aliases providers actually send. They resolve to the same extension as
  // their canonical spelling but are not the canonical MIME type themselves.
  ["image/jpg", ".jpg"],
  ["audio/mp3", ".mp3"],
  ["audio/mpeg3", ".mp3"],
  ["audio/x-wav", ".wav"],
  ["audio/wave", ".wav"],
  ["audio/x-flac", ".flac"],
  ["audio/ogg", ".opus"],
]);

/** Lower-cased MIME type with any `;charset=…` / `;codecs=…` parameters stripped. */
export function normalizeMimeType(value: string | undefined | null): string {
  return value?.toLowerCase().split(";")[0]?.trim() ?? "";
}

/** Lower-cased extension including the leading dot, or `""` when there is none. */
export function extensionForPath(path: string): string {
  const fileName = path.split(/[\\/]/u).pop() ?? path;
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

export function mimeTypeForPath(
  path: string,
  fallback: string = ARTIFACT_MIME_TYPES.binary,
): string {
  return MIME_TYPE_BY_EXTENSION.get(extensionForPath(path)) ?? fallback;
}

/**
 * Canonical extension (with leading dot) for a MIME type.
 *
 * Matching is exact after parameter stripping. The substring matching this
 * replaced classified `application/x-gif-thing` as a GIF and
 * `application/x-wav-container` as a WAV; unknown types now take the caller's
 * explicit fallback instead of whatever the first matching `includes()` said.
 */
export function extensionForMimeType(
  mimeType: string | undefined | null,
  fallback: string,
): string {
  return EXTENSION_BY_MIME_TYPE.get(normalizeMimeType(mimeType)) ?? fallback;
}

/** Identify raster bytes independently of the provider's MIME or file suffix. */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const tag = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(tag(0, 6)))
    return "image/gif";
  if (bytes.length >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP")
    return "image/webp";
  return null;
}

/**
 * The audio container a byte buffer actually is, read from its magic bytes — or
 * null when it is not an audio container we can identify unambiguously.
 *
 * Use this instead of trusting a provider's declared MIME. Some speech
 * providers stream WAV even when mp3 is requested; a file whose bytes are PCM
 * WAV but whose stored MIME says `audio/mpeg` makes a browser `<audio>` element
 * hand PCM to its MP3 decoder, which stutters and mis-seeks (choppy playback +
 * audio/video desync in the frame-synced preview). A server-side mp4 render is
 * unaffected because ffmpeg sniffs the container itself. Only signatures that
 * are unmistakable are returned, so a real mp3 is never re-labeled.
 */
export function sniffAudioMimeType(
  bytes: Uint8Array,
): ArtifactMimeType | "audio/mp4" | null {
  if (bytes.length < 4) {
    return null;
  }
  const tag = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE") {
    return ARTIFACT_MIME_TYPES.wav;
  }
  if (tag(0, 4) === "fLaC") {
    return ARTIFACT_MIME_TYPES.flac;
  }
  if (tag(0, 4) === "OggS") {
    // Opus/Vorbis both ride in an Ogg container; the artifact layer treats the
    // container as the servable type.
    return "audio/ogg" as ArtifactMimeType;
  }
  // ID3v2 tag, or a raw MPEG audio frame sync (11 bits set).
  if (tag(0, 3) === "ID3") {
    return ARTIFACT_MIME_TYPES.mp3;
  }
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return ARTIFACT_MIME_TYPES.mp3;
  }
  if (bytes.length >= 12 && tag(4, 4) === "ftyp") {
    return "audio/mp4";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Purpose-scoped allowlists                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Raster formats accepted as a standalone `image` artifact. Deliberately
 * narrower than "anything that decodes": SVG is script-bearing and GIF/AVIF are
 * not worth the downstream thumbnailing surface.
 */
export const ARTIFACT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  ARTIFACT_MIME_TYPES.png,
  ARTIFACT_MIME_TYPES.jpeg,
  ARTIFACT_MIME_TYPES.webp,
]);

/** Formats accepted as an artifact preview thumbnail. */
export const ARTIFACT_PREVIEW_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  ARTIFACT_MIME_TYPES.png,
  ARTIFACT_MIME_TYPES.jpeg,
  ARTIFACT_MIME_TYPES.webp,
]);

/** Formats accepted for generated narration audio. */
export const ARTIFACT_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  ARTIFACT_MIME_TYPES.mp3,
  ARTIFACT_MIME_TYPES.wav,
  ARTIFACT_MIME_TYPES.aac,
  ARTIFACT_MIME_TYPES.opus,
  ARTIFACT_MIME_TYPES.flac,
]);

export function isArtifactImageMimeType(value: string | undefined | null) {
  return ARTIFACT_IMAGE_MIME_TYPES.has(normalizeMimeType(value));
}

export function isArtifactPreviewImageMimeType(
  value: string | undefined | null,
) {
  return ARTIFACT_PREVIEW_IMAGE_MIME_TYPES.has(normalizeMimeType(value));
}

export function isArtifactAudioMimeType(value: string | undefined | null) {
  return ARTIFACT_AUDIO_MIME_TYPES.has(normalizeMimeType(value));
}

/** Whether the browser can be trusted to render this inline rather than download it. */
export function isInlinePreviewableMimeType(contentType: string): boolean {
  const normalized = normalizeMimeType(contentType);
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("text/") ||
    normalized === ARTIFACT_MIME_TYPES.pdf ||
    normalized === ARTIFACT_MIME_TYPES.json
  );
}

/* -------------------------------------------------------------------------- */
/* Size limits                                                                 */
/* -------------------------------------------------------------------------- */

const MEGABYTE = 1024 * 1024;

/**
 * One place to see every artifact size ceiling and how they relate.
 *
 * `image` is half of `file` on purpose: an image artifact is decoded in the
 * browser and thumbnailed server-side, so it carries costs a plain file
 * download does not.
 *
 * Preview images are an *enhancement*, so exceeding `previewImageBytes` skips
 * the thumbnail rather than failing the publish; exceeding any of the others
 * fails the publish, because the artifact itself is the deliverable.
 */
export const ARTIFACT_LIMITS = {
  /** Self-contained HTML must fit the existing storage read boundary. */
  htmlBytes: 25 * MEGABYTE,
  /** Any published `file` artifact. Exceeding this fails the publish. */
  fileBytes: 100 * MEGABYTE,
  /** A published `.pptx` deck. Exceeding this fails the publish. */
  pptxBytes: 100 * MEGABYTE,
  /** A published `image` artifact. Exceeding this fails the publish. */
  imageBytes: 50 * MEGABYTE,
  /** An artifact thumbnail. Exceeding this drops the thumbnail, not the publish. */
  previewImageBytes: 5 * MEGABYTE,
} as const;

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace and ellipsize to `maxLength`, for artifact titles and prompts. */
export function compactArtifactText(value: string, maxLength = 120): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}
