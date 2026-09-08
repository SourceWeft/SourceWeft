/** Browser-safe capability catalog, matched to AnyDoc v0.2.4 Format::from_extension.
 * Source: https://github.com/firecrawl/anydoc/blob/v0.2.4/src/lib.rs
 */
export const anydocFormatCatalog = [
  {
    format: "doc",
    mimeType: "application/msword",
    extensions: ["doc"],
    mimeAliases: ["application/vnd.ms-word"],
  },
  {
    format: "docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    mimeAliases: [],
  },
  {
    format: "docx",
    mimeType: "application/vnd.ms-word.document.macroenabled.12",
    extensions: ["docm"],
    mimeAliases: [],
  },
  {
    format: "ppt",
    mimeType: "application/vnd.ms-powerpoint",
    extensions: ["ppt", "pps", "pot"],
    mimeAliases: ["application/mspowerpoint", "application/x-mspowerpoint"],
  },
  {
    format: "pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: ["pptx"],
    mimeAliases: [],
  },
  {
    format: "pptx",
    mimeType: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    extensions: ["pptm"],
    mimeAliases: [],
  },
  {
    format: "pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    extensions: ["ppsx"],
    mimeAliases: [],
  },
  {
    format: "pptx",
    mimeType: "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    extensions: ["ppsm"],
    mimeAliases: [],
  },
  {
    format: "xlsx",
    mimeType: "application/vnd.ms-excel",
    extensions: ["xls"],
    mimeAliases: ["application/msexcel", "application/x-msexcel"],
  },
  {
    format: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
    mimeAliases: [],
  },
  {
    format: "xlsx",
    mimeType: "application/vnd.ms-excel.sheet.macroenabled.12",
    extensions: ["xlsm"],
    mimeAliases: [],
  },
  {
    format: "xlsx",
    mimeType: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    extensions: ["xlsb"],
    mimeAliases: [],
  },
  {
    format: "odt",
    mimeType: "application/vnd.oasis.opendocument.text",
    extensions: ["odt"],
    mimeAliases: [],
  },
  {
    format: "ods",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
    extensions: ["ods"],
    mimeAliases: [],
  },
  {
    format: "odp",
    mimeType: "application/vnd.oasis.opendocument.presentation",
    extensions: ["odp"],
    mimeAliases: [],
  },
  {
    format: "rtf",
    mimeType: "application/rtf",
    extensions: ["rtf"],
    mimeAliases: ["text/rtf", "application/x-rtf"],
  },
  {
    format: "epub",
    mimeType: "application/epub+zip",
    extensions: ["epub"],
    mimeAliases: [],
  },
  {
    format: "csv",
    mimeType: "text/csv",
    extensions: ["csv"],
    mimeAliases: ["application/csv"],
  },
  {
    format: "pdf",
    mimeType: "application/pdf",
    extensions: ["pdf"],
    mimeAliases: [
      "application/x-pdf",
      "application/acrobat",
      "applications/vnd.pdf",
    ],
  },
] as const;

export type AnydocFormatDefinition = (typeof anydocFormatCatalog)[number];
export type AnydocFormat = AnydocFormatDefinition["format"];
export const anydocMimeTypes: readonly string[] = anydocFormatCatalog.flatMap(
  (entry) => [entry.mimeType, ...entry.mimeAliases],
);
export const anydocExtensions: readonly string[] = anydocFormatCatalog.flatMap(
  (entry) => [...entry.extensions],
);

export function getAnydocFormatByExtension(
  extension: string,
): AnydocFormatDefinition | undefined {
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  return anydocFormatCatalog.find((entry) =>
    (entry.extensions as readonly string[]).includes(normalized),
  );
}

export function getAnydocFormatByMimeType(
  mimeType: string,
): AnydocFormatDefinition | undefined {
  const normalized = mimeType.trim().toLowerCase();
  return anydocFormatCatalog.find(
    (entry) =>
      entry.mimeType === normalized ||
      (entry.mimeAliases as readonly string[]).includes(normalized),
  );
}

export function isAnydocMimeType(mimeType: string): boolean {
  return getAnydocFormatByMimeType(mimeType) !== undefined;
}
