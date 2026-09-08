import type { Format, NeedsOcrError } from "@firecrawl/anydoc";
import { buildParsedDocument } from "./build-parsed-document";
import { ParserContentError } from "./errors";
import { readAnydocBillingMetadata } from "./anydoc-billing-metadata";
import { readPdfPageCount } from "./pdf-page-count";
import type { ParsedDocument, ParseInput } from "./types";

/** Only formats exercised by our integration are enabled here. */
export const anydocMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/epub+zip",
  "text/csv",
  "application/csv",
] as const;

const formats: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/epub+zip": "epub",
  "text/csv": "csv",
  "application/csv": "csv",
};

export function isAnydocMimeType(mimeType: string): boolean {
  return Object.hasOwn(formats, mimeType);
}

/** No message matching: malformed/encrypted/limit failures must never enable OCR. */
export function isAnydocNeedsOcrError(error: unknown): error is NeedsOcrError {
  return error instanceof Error && "code" in error && error.code === "needsOcr";
}

export async function parseWithAnydoc(
  input: ParseInput,
): Promise<ParsedDocument> {
  const expectedFormat = formats[input.mimeType];
  if (!expectedFormat) {
    throw new ParserContentError(
      400,
      "ANYDOC_UNSUPPORTED_MIME",
      `AnyDoc does not support MIME type: ${input.mimeType}`,
    );
  }
  if (input.content.length === 0) {
    throw new ParserContentError(
      400,
      "ANYDOC_EMPTY_FILE",
      "Cannot parse an empty document.",
    );
  }
  // Keep native loading behind the explicit AnyDoc route; legacy parsing must
  // not require an installed native binary merely by importing this package.
  const { formatFromBytes, toMarkdownBytes } =
    await import("@firecrawl/anydoc");
  const detectedFormat = formatFromBytes(input.content);
  if (detectedFormat !== null && detectedFormat !== expectedFormat) {
    throw new ParserContentError(
      400,
      "ANYDOC_FORMAT_MISMATCH",
      `Document bytes identify ${detectedFormat}, but MIME type declares ${expectedFormat}.`,
    );
  }
  // CSV has no signature; all other formats must be detected from their bytes.
  // Explicit reject prevents ambient Firecrawl credentials from enabling uploads.
  const content = await toMarkdownBytes(
    input.content,
    expectedFormat === "csv" ? ("csv" as Format) : undefined,
    { ocr: "reject" },
  );
  if (!content.trim()) {
    throw new ParserContentError(
      422,
      "ANYDOC_NO_CONTENT",
      "AnyDoc extracted no document content.",
    );
  }
  // Reliable total pages for billing; this cannot provide content-to-page locations.
  const pageCount =
    expectedFormat === "pdf"
      ? await readPdfPageCount(input.content)
      : undefined;
  const billingMetadata = await readAnydocBillingMetadata(input);
  return buildParsedDocument({
    parseInput: input,
    content,
    pages: [],
    metadata: {
      ...billingMetadata,
      documentParseBackend: "anydoc",
      parserEngine: "anydoc",
      parserEngineVersion: "0.2.4",
      detectedFormat: detectedFormat ?? expectedFormat,
      pageLocationAvailable: false,
      pageCount,
      ...(expectedFormat === "pdf" ? { pageCountSource: "pdfjs" } : {}),
    },
  });
}
