/**
 * What kind of file a skill file is — decided once, the same way, for every
 * source: a repository read over the network and a builtin read from disk.
 * Pure: no storage, no IO.
 */

/** Any other text serves as plain. */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/**
 * What skills actually ship next to their text: fonts (anthropics/skills
 * carries 56 `.ttf` under `canvas-design/`), images, document templates. The
 * type is recorded on the manifest row and set on the stored blob; a binary
 * with no entry here is an opaque octet stream.
 */
const BINARY_MIME_BY_EXTENSION: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dotx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xltx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potx":
    "application/vnd.openxmlformats-officedocument.presentationml.template",
};

/**
 * Whether the bytes are text a reader can be handed as a string: valid UTF-8
 * with no NUL. Decided by round-trip, not by extension — a lossy decode would
 * produce a string whose bytes no longer match the file's sha256. Everything
 * else is carried as the bytes it is; nothing is dropped for being binary.
 */
function isUtf8Text(bytes: Buffer, decoded: string): boolean {
  return !decoded.includes("\0") && Buffer.from(decoded, "utf8").equals(bytes);
}

function mimeTypeFor(bundlePath: string, isText: boolean): string {
  const dot = bundlePath.lastIndexOf(".");
  const ext = dot < 0 ? "" : bundlePath.slice(dot).toLowerCase();
  return isText
    ? (TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain")
    : (BINARY_MIME_BY_EXTENSION[ext] ?? "application/octet-stream");
}

export type SkillFileKind = {
  mimeType: string;
} & (
  { isText: true; contentText: string } | { isText: false; contentText: null }
);

/** The one place `isText` is decided. */
export function classifySkillFile(
  path: string,
  raw: Uint8Array,
): SkillFileKind {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const decoded = bytes.toString("utf8");
  return isUtf8Text(bytes, decoded)
    ? { isText: true, contentText: decoded, mimeType: mimeTypeFor(path, true) }
    : { isText: false, contentText: null, mimeType: mimeTypeFor(path, false) };
}
