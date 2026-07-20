import {
  extensionForPath,
  sanitizeArtifactFileBase,
} from "@sourceweft/contracts/artifact-files";

/**
 * File naming for published artifacts.
 *
 * Sanitizing, the MIME/extension table and the size limits all live in
 * `@sourceweft/contracts/artifact-files` now; this module keeps only the
 * publish-specific composition of them — how a title plus a source path become
 * a download name. The re-exports below let existing importers of this package
 * keep working unchanged.
 */
export {
  ARTIFACT_LIMITS,
  ARTIFACT_MIME_TYPES,
  extensionForPath,
  isInlinePreviewableMimeType,
  mimeTypeForPath,
  normalizeMimeType,
} from "@sourceweft/contracts/artifact-files";

const PUBLISHED_FILE_BASE_FALLBACK = "artifact";

/** Sanitized base name for a published artifact, minus its extension. */
export function sanitizeFileBase(value: string) {
  return sanitizeArtifactFileBase(value, {
    fallback: PUBLISHED_FILE_BASE_FALLBACK,
  });
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

/**
 * Prefer the source path's own file name, falling back to the title when the
 * path ends in nothing usable.
 */
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
