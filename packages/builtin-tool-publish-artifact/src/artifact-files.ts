export function sanitizeFileBase(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  return normalized.length > 0 ? normalized : "artifact";
}

export function extensionForPath(path: string) {
  const fileName = path.split(/[\\/]/u).pop() ?? path;
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

export const ARTIFACT_MIME_TYPES = {
  binary: "application/octet-stream",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  jpeg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  text: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
} as const;

const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".pptx", ARTIFACT_MIME_TYPES.pptx],
  [".pdf", ARTIFACT_MIME_TYPES.pdf],
  [".html", ARTIFACT_MIME_TYPES.html],
  [".htm", ARTIFACT_MIME_TYPES.html],
  [".docx", ARTIFACT_MIME_TYPES.docx],
  [".xlsx", ARTIFACT_MIME_TYPES.xlsx],
  [".csv", ARTIFACT_MIME_TYPES.csv],
  [".json", ARTIFACT_MIME_TYPES.json],
  [".txt", ARTIFACT_MIME_TYPES.text],
  [".md", ARTIFACT_MIME_TYPES.text],
  [".zip", ARTIFACT_MIME_TYPES.zip],
  [".png", ARTIFACT_MIME_TYPES.png],
  [".jpg", ARTIFACT_MIME_TYPES.jpeg],
  [".jpeg", ARTIFACT_MIME_TYPES.jpeg],
  [".webp", ARTIFACT_MIME_TYPES.webp],
]);

export function mimeTypeForPath(path: string) {
  return (
    MIME_TYPE_BY_EXTENSION.get(extensionForPath(path)) ??
    ARTIFACT_MIME_TYPES.binary
  );
}

export function normalizeMimeType(value: string | undefined | null) {
  return value?.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function isInlinePreviewableMimeType(contentType: string) {
  const normalized = normalizeMimeType(contentType);
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("text/") ||
    normalized === ARTIFACT_MIME_TYPES.pdf ||
    normalized === ARTIFACT_MIME_TYPES.json
  );
}

export function fileNameForTitle(input: {
  readonly title: string;
  readonly extension: string;
}) {
  const extension = input.extension.startsWith(".")
    ? input.extension
    : `.${input.extension}`;
  return `${sanitizeFileBase(input.title)}${extension}`;
}

export function fileNameForPathOrTitle(input: {
  readonly path: string;
  readonly title: string;
}) {
  const fileName = input.path.split(/[\\/]/u).pop()?.trim() ?? "";
  if (fileName && fileName !== "." && fileName !== "..") {
    const sanitizedBase = sanitizeFileBase(
      fileName.slice(0, fileName.length - extensionForPath(fileName).length) ||
        fileName,
    );
    return `${sanitizedBase}${extensionForPath(fileName)}`;
  }
  return fileNameForTitle({
    title: input.title,
    extension: extensionForPath(input.path) || ".bin",
  });
}
