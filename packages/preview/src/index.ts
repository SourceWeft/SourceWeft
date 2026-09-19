/** Hosts supply authorized bytes or URLs; no artifact or native bridge dependencies. */
export type PreviewLocation = { page?: number; line?: number; quote?: string };

export type PreviewSource = {
  name: string;
  mimeType?: string | null;
} & (
  | { url: string; blob?: never; text?: never }
  | { blob: Blob; url?: never; text?: never }
  | { text: string; url?: never; blob?: never }
);

export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

const families = {
  pdf: ["pdf"],
  word: ["doc", "docx", "dot", "docm", "dotx", "rtf", "odt", "odp"],
  spreadsheet: ["xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods"],
  presentation: ["pptx", "pptm", "ppsx", "potx"],
  legacyPresentation: ["ppt", "pot"],
  epub: ["epub"],
  lite: [
    "txt",
    "md",
    "markdown",
    "json",
    "xml",
    "yaml",
    "yml",
    "log",
    "js",
    "jsx",
    "ts",
    "tsx",
    "py",
    "rs",
    "go",
    "java",
    "css",
    "sql",
    "sh",
    "toml",
    "ini",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "ico",
    "svg",
    "mp3",
    "wav",
    "ogg",
    "m4a",
    "flac",
    "mp4",
    "webm",
    "mov",
  ],
} as const;
export type PreviewFamily = keyof typeof families;
const mimeExtensions: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/epub+zip": "epub",
  "application/rtf": "rtf",
  "application/json": "json",
  "application/xml": "xml",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "txt",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
export function previewFileName(name: string, mimeType?: string | null) {
  const base = name.split(/[\\/]/).pop() || "File";
  if (previewFamily(base)) return base;
  const extension =
    mimeExtensions[mimeType?.split(";")[0]?.trim().toLowerCase() ?? ""];
  return extension ? `${base}.${extension}` : base;
}
export function previewFamily(name: string): PreviewFamily | null {
  const extension = name.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  for (const [family, extensions] of Object.entries(families)) {
    if ((extensions as readonly string[]).includes(extension ?? ""))
      return family as PreviewFamily;
  }
  return null;
}

/** Bounded streaming read, also used by the native-file host adapter. */
export async function readPreviewBlob(
  response: Response,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!response.ok)
    throw new Error(`Could not load file (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new Error(
      "This file exceeds the 32 MB preview limit. Download it to open it.",
    );
  }
  if (!response.body) throw new Error("The file response has no body.");
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PREVIEW_BYTES)
        throw new Error(
          "This file exceeds the 32 MB preview limit. Download it to open it.",
        );
      chunks.push(value.slice().buffer);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}
