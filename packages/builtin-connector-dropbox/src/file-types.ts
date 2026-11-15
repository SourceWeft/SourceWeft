import {
  classifySourceFile,
  CONNECTOR_FILE_KINDS,
} from "@sourceweft/builtin-document-parsers/file-types";

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

/** How to extract content from a Dropbox file, keyed by its name and whether
 * Dropbox reports it as downloadable. `isDownloadable` mirrors Dropbox's own
 * `is_downloadable` metadata field, which is false for files the content API
 * cannot read as bytes (e.g. a `.paper` doc has to be exported instead of
 * downloaded).
 *
 * Supported file types are the platform's own file-type classification
 * (`@sourceweft/builtin-document-parsers/file-types`) — the same rules
 * uploads and every other connector are held to — restricted to the kinds a
 * connector sync can resolve (`CONNECTOR_FILE_KINDS`): document, text,
 * table, and json. Images, audio, and transcripts are never indexable from
 * Dropbox. */
export function resolveDropboxFileHandling(
  name: string,
  isDownloadable: boolean,
): DropboxFileHandling {
  const extension = extensionOf(name);
  if (extension === "paper") {
    return { kind: "export_paper", mimeType: "text/markdown" };
  }
  if (!isDownloadable) {
    return { kind: "unsupported" };
  }
  const classification = classifySourceFile({ fileName: name });
  if (classification.supported && CONNECTOR_FILE_KINDS.has(classification.kind)) {
    return { kind: "download", mimeType: classification.mimeType };
  }
  return { kind: "unsupported" };
}

export function isDropboxFileSupported(
  name: string,
  isDownloadable: boolean,
): boolean {
  return resolveDropboxFileHandling(name, isDownloadable).kind !== "unsupported";
}
