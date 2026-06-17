import { config } from "../../../../shared/config";
import type { PdfClassification } from "./types";
import { summarizeNumbers } from "./utils";

type PdfJsModule = {
  OPS: Record<string, number>;
  getDocument(input: { data: Uint8Array; disableWorker: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
        getOperatorList(): Promise<PdfOperatorList>;
        cleanup(): void;
      }>;
      destroy(): Promise<void>;
    }>;
  };
};

function ensurePdfJsNodePolyfills() {
  const globalObject = globalThis as Record<string, unknown>;

  globalObject.DOMMatrix ??= class DOMMatrix {};
  globalObject.ImageData ??= class ImageData {};
  globalObject.Path2D ??= class Path2D {};
}

async function loadPdfJs() {
  ensurePdfJsNodePolyfills();
  return (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as unknown as PdfJsModule;
}

type PdfOperatorList = {
  fnArray: number[];
  argsArray: unknown[];
};

function getImageOperatorIds(pdfjs: PdfJsModule) {
  const ops = pdfjs.OPS;
  return new Set(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintJpegXObject,
      ops.paintImageMaskXObject,
      ops.paintImageXObjectRepeat,
      ops.paintImageMaskXObjectRepeat,
      ops.paintInlineImageXObjectGroup,
      ops.paintImageXObjectGroup,
    ].filter((value): value is number => typeof value === "number"),
  );
}

function classifyFromSignals(input: {
  pageCount: number;
  textCharsByPage: number[];
  imageOpsByPage: number[];
}): PdfClassification {
  const threshold = config.documentParsing.pureTextBitmapThreshold;
  const minCharsPerPage = config.documentParsing.pureTextMinCharsPerPage;
  const bitmapCoverage = input.imageOpsByPage.map((count) =>
    Math.min(1, count > 0 ? 1 : 0),
  );
  const summary = summarizeNumbers(bitmapCoverage);
  const textPages = input.textCharsByPage.filter(
    (chars) => chars >= minCharsPerPage,
  ).length;
  const textPageRatio = input.pageCount > 0 ? textPages / input.pageCount : 0;
  const imageHeavyPages = bitmapCoverage.filter(
    (coverage) => coverage > threshold,
  ).length;
  const imagePageRatio =
    input.pageCount > 0 ? imageHeavyPages / input.pageCount : 0;

  if (textPageRatio >= 0.8 && summary.avg <= threshold) {
    return {
      kind: "pure_text",
      confidence: Math.min(
        0.99,
        0.7 + textPageRatio * 0.2 + (threshold - summary.avg),
      ),
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

export async function classifyPdf(content: Buffer): Promise<PdfClassification> {
  const pdfjs = await loadPdfJs();
  const imageOperatorIds = getImageOperatorIds(pdfjs);
  const document = await pdfjs.getDocument({
    data: new Uint8Array(content),
    disableWorker: true,
  }).promise;
  const pageCount = document.numPages;
  const textCharsByPage: number[] = [];
  const imageOpsByPage: number[] = [];

  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    const page = await document.getPage(pageNo);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) =>
        "str" in item && typeof item.str === "string" ? item.str : "",
      )
      .join(" ")
      .trim();
    const operatorList = (await page.getOperatorList()) as PdfOperatorList;
    const imageOps = operatorList.fnArray.filter((fn) =>
      imageOperatorIds.has(fn),
    ).length;

    textCharsByPage.push(text.length);
    imageOpsByPage.push(imageOps);
    page.cleanup();
  }

  await document.destroy();
  return classifyFromSignals({ pageCount, textCharsByPage, imageOpsByPage });
}
