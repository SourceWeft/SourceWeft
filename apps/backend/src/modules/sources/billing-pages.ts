import { resolveIngestionPages } from "@sourceweft/credits-core";
import { getAnydocFormatByMimeType } from "@sourceweft/builtin-document-parsers/formats";
import { isSupportedImageMimeType } from "@sourceweft/builtin-document-parsers";
import { ContentError } from "../content/errors";

/** Match the existing source token estimate; blank sources are not indexable. */
export function estimateSourceTokens(
  contentText: string | null | undefined,
): number {
  return contentText?.trim()
    ? Math.max(1, Math.ceil(contentText.length / 4))
    : 0;
}

/** Only physical PDF/image pages qualify. Office/CSV/chapter/ASR counts do not. */
export function resolvePhysicalPageCount(input: {
  mimeType?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}): number | undefined {
  if (input.mimeType && isSupportedImageMimeType(input.mimeType)) return 1;
  if (
    !input.mimeType ||
    getAnydocFormatByMimeType(input.mimeType)?.format !== "pdf"
  )
    return undefined;
  const metadata = input.metadata ?? {};
  const count = metadata.pageCount;
  const declaredPhysicalSource =
    metadata.pageCountSource === "pdfjs" || metadata.pageCountSource === "ocr";
  if (
    count !== undefined &&
    declaredPhysicalSource &&
    (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
  ) {
    throw new ContentError(
      422,
      "INVALID_PHYSICAL_PAGE_COUNT",
      "Trusted PDF page count must be a positive safe integer",
    );
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
    return undefined;
  if (declaredPhysicalSource) return count;
  // Before pageCountSource existed, these PDF providers persisted real page totals.
  // Non-PDF legacy logical page/chapter counts never enter this branch.
  if (
    metadata.pageCountSource === undefined &&
    (metadata.documentParseBackend === "langchain" ||
      metadata.documentParseBackend === "pdf2markdown")
  )
    return count;
  return undefined;
}

export function resolveBillingPages(input: {
  physicalPageCount?: number;
  contentText?: string | null;
}): number {
  const parsedTokens = estimateSourceTokens(input.contentText);
  if (parsedTokens === 0) {
    throw new ContentError(
      400,
      "INGESTION_CONTENT_MISSING",
      "Nonempty source content is required for ingestion billing",
    );
  }
  if (input.physicalPageCount !== undefined) {
    if (
      !Number.isSafeInteger(input.physicalPageCount) ||
      input.physicalPageCount <= 0
    ) {
      throw new ContentError(
        422,
        "INVALID_PHYSICAL_PAGE_COUNT",
        "Physical page count must be a positive safe integer",
      );
    }
    return input.physicalPageCount;
  }
  // Token-only invocation is intentional: reported pages must not compete with
  // text equivalents, and old caller/source estimates are not billing evidence.
  return resolveIngestionPages({ parsedTokens });
}
