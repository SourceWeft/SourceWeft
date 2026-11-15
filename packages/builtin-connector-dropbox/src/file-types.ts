/** Dropbox files this connector can extract are identified purely by name
 * extension: unlike Drive, the Dropbox API reports no structured MIME type
 * on file metadata. `isDownloadable` mirrors Dropbox's own `is_downloadable`
 * metadata field, which is false for files the content API cannot read as
 * bytes (e.g. a `.paper` doc has to be exported instead of downloaded). */
const DOWNLOAD_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
};

/**
 * How to extract a Dropbox file. `mimeType` on the download variant is the
 * MIME type of the content the platform will actually receive, written onto
 * the discovered `ConnectorItem`.
 */
export type DropboxFileHandling =
  | { kind: "download"; mimeType: string }
  | { kind: "export_paper"; mimeType: "text/markdown" }
  | { kind: "unsupported" };

/** Returns the lower-cased text after the last `.` in `name`, or `null` when
 * `name` has no extension (e.g. `README`). */
function extensionOf(name: string): string | null {
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1 || lastDot === name.length - 1) {
    return null;
  }
  return name.slice(lastDot + 1).toLowerCase();
}

/** How to extract content from a Dropbox file, keyed by its name extension
 * and whether Dropbox reports it as downloadable. */
export function resolveDropboxFileHandling(
  name: string,
  isDownloadable: boolean,
): DropboxFileHandling {
  const extension = extensionOf(name);
  if (extension === "paper") {
    return { kind: "export_paper", mimeType: "text/markdown" };
  }
  if (extension !== null && isDownloadable) {
    const mimeType = DOWNLOAD_MIME_TYPES_BY_EXTENSION[extension];
    if (mimeType !== undefined) {
      return { kind: "download", mimeType };
    }
  }
  return { kind: "unsupported" };
}

export function isDropboxFileSupported(
  name: string,
  isDownloadable: boolean,
): boolean {
  return resolveDropboxFileHandling(name, isDownloadable).kind !== "unsupported";
}
