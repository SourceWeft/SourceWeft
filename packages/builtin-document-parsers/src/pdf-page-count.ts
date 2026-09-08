import { ParserContentError } from "./errors";

/** Metadata inspection only: never extracts/replaces AnyDoc document content. */
export async function readPdfPageCount(content: Buffer): Promise<number> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(content),
    useSystemFonts: false,
  });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new ParserContentError(
        422,
        "PDF_PAGE_COUNT_INVALID",
        "PDF metadata does not contain a valid page count.",
      );
    }
    return document.numPages;
  } finally {
    await task.destroy();
  }
}
