// Drive-native (application/vnd.google-apps.*) MIME types.
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

const XLSX_EXPORT_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Already-binary/text Drive files that are extracted by downloading the
 * stored bytes as-is, with no Drive export step. */
const DOWNLOAD_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

const DOWNLOAD_MIME_TYPE_SET = new Set<string>(DOWNLOAD_MIME_TYPES);

/** MIME types the Drive file picker should let a user select: every type this
 * module knows how to extract, i.e. the union of the three Drive-native
 * exports plus the download set. Unsupported types are deliberately left out
 * so the picker never offers a file this connector cannot ingest. */
export const GOOGLE_DRIVE_PICKER_MIME_TYPES: readonly string[] = [
  GOOGLE_DOC_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE,
  GOOGLE_SHEET_MIME_TYPE,
  ...DOWNLOAD_MIME_TYPES,
];

/**
 * How to extract a Drive file. `itemMimeType` is the MIME type of the content
 * the platform will actually receive, so it is the type written onto the
 * discovered `ConnectorItem`: the export MIME for Google-native files and the
 * original stored MIME for a plain download. (The unsupported variant has no
 * `itemMimeType`; callers fall back to the original Drive MIME there.)
 */
export type DriveFileHandling =
  | {
      kind: "export_text";
      exportMimeType: "text/markdown" | "text/plain";
      itemMimeType: "text/markdown" | "text/plain";
      asMarkdown: boolean;
    }
  | {
      kind: "export_file";
      exportMimeType: string;
      itemMimeType: string;
      extension: "xlsx";
    }
  | { kind: "download"; itemMimeType: string }
  | { kind: "unsupported" };

/** How to extract content from a Drive file, keyed by its reported MIME type. */
export function resolveDriveFileHandling(
  driveMimeType: string,
): DriveFileHandling {
  if (driveMimeType === GOOGLE_DOC_MIME_TYPE) {
    return {
      kind: "export_text",
      exportMimeType: "text/markdown",
      itemMimeType: "text/markdown",
      asMarkdown: true,
    };
  }
  if (driveMimeType === GOOGLE_SLIDES_MIME_TYPE) {
    return {
      kind: "export_text",
      exportMimeType: "text/plain",
      itemMimeType: "text/plain",
      asMarkdown: false,
    };
  }
  if (driveMimeType === GOOGLE_SHEET_MIME_TYPE) {
    return {
      kind: "export_file",
      exportMimeType: XLSX_EXPORT_MIME_TYPE,
      itemMimeType: XLSX_EXPORT_MIME_TYPE,
      extension: "xlsx",
    };
  }
  if (DOWNLOAD_MIME_TYPE_SET.has(driveMimeType)) {
    return { kind: "download", itemMimeType: driveMimeType };
  }
  return { kind: "unsupported" };
}

/** Appends `.<extension>` unless `name` already ends with it (case-insensitive). */
export function exportedFileName(name: string, extension: string): string {
  const suffix = `.${extension}`;
  return name.toLowerCase().endsWith(suffix.toLowerCase())
    ? name
    : `${name}${suffix}`;
}
