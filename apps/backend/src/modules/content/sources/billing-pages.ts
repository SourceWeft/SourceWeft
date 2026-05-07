import { ContentError } from "../errors";

function firstPositivePageCount(
  values: Array<number | null | undefined>,
): number | null {
  for (const value of values) {
    if (Number.isFinite(value) && (value ?? 0) > 0) {
      return Math.ceil(value ?? 0);
    }
  }

  return null;
}

export function resolveBillingPages(input: {
  parsedPages?: number | null;
  estimatedPages?: number | null;
  sourceEstimatedPages?: number | null;
  chunkCount?: number;
  contentText?: string | null;
}) {
  const pages = firstPositivePageCount([
    input.parsedPages,
    input.estimatedPages,
    input.sourceEstimatedPages,
  ]);
  if (pages) {
    return pages;
  }

  if ((input.chunkCount ?? 0) > 0 || (input.contentText?.trim().length ?? 0) > 0) {
    return 1;
  }

  throw new ContentError(
    400,
    "INGESTION_PAGE_COUNT_MISSING",
    "Parsed page count is required for source ingestion billing",
  );
}
