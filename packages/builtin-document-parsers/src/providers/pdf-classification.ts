import type { PdfClassification } from "./types";

export type PdfClassificationConfig = {
  readonly pureTextBitmapThreshold: number;
  readonly pureTextMinCharsPerPage: number;
};

export function classifyPdfSignals(input: {
  readonly pageCount: number;
  readonly textCharsByPage: readonly number[];
  readonly imageOpsByPage: readonly number[];
  readonly config: PdfClassificationConfig;
}): PdfClassification {
  const threshold = input.config.pureTextBitmapThreshold;
  const minCharsPerPage = input.config.pureTextMinCharsPerPage;
  const bitmapCoverage = input.imageOpsByPage.map((count) =>
    Math.min(1, count > 0 ? 1 : 0),
  );
  const avg = bitmapCoverage.length
    ? bitmapCoverage.reduce((sum, value) => sum + value, 0) /
      bitmapCoverage.length
    : 0;
  const textPages = input.textCharsByPage.filter(
    (chars) => chars >= minCharsPerPage,
  ).length;
  const textPageRatio = input.pageCount > 0 ? textPages / input.pageCount : 0;
  const imageHeavyPages = bitmapCoverage.filter(
    (coverage) => coverage > threshold,
  ).length;
  const imagePageRatio =
    input.pageCount > 0 ? imageHeavyPages / input.pageCount : 0;

  if (textPageRatio >= 0.8 && avg <= threshold) {
    return {
      kind: "pure_text",
      confidence: Math.min(0.99, 0.7 + textPageRatio * 0.2 + (threshold - avg)),
      pageCount: input.pageCount,
      bitmapCoverage,
    };
  }

  return {
    kind: "non_pure_text",
    confidence: Math.min(
      0.99,
      0.65 + imagePageRatio * 0.25 + (1 - textPageRatio) * 0.1,
    ),
    pageCount: input.pageCount,
    bitmapCoverage,
    reason:
      imagePageRatio >= 0.8
        ? "scan_like"
        : imagePageRatio > 0
          ? "hybrid"
          : "unknown",
  };
}
