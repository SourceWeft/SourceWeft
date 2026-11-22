const MAX_FILE_NAME_CHARS = 80;
const FALLBACK_FILE_NAME = "chat";

/**
 * A file name built from a chat title: characters that are unsafe in file
 * names become `-`, whitespace collapses, and the result keeps non-ASCII text.
 * A title with no letter or digit left falls back to `chat`.
 */
export function exportFileBaseName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(cleaned).slice(0, MAX_FILE_NAME_CHARS).join("").trim();
  return /[\p{L}\p{N}]/u.test(cut) ? cut : FALLBACK_FILE_NAME;
}

function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `Content-Disposition` for a download, with an ASCII fallback name. */
export function contentDispositionAttachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
