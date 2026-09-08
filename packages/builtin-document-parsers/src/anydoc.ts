import type { Format, NeedsOcrError } from "@firecrawl/anydoc";
import { buildParsedDocument } from "./build-parsed-document";
import { ParserContentError } from "./errors";
import { readPdfPageCount } from "./pdf-page-count";
import type { ParsedDocument, ParseInput } from "./types";

export { anydocMimeTypes, isAnydocMimeType } from "./anydoc-formats";
import { anydocMimeTypes, getAnydocFormatByMimeType } from "./anydoc-formats";

/** No message matching: malformed/encrypted/limit failures must never enable OCR. */
export function isAnydocNeedsOcrError(error: unknown): error is NeedsOcrError {
  return error instanceof Error && "code" in error && error.code === "needsOcr";
}

export async function parseWithAnydoc(
  input: ParseInput,
): Promise<ParsedDocument> {
  const expectedFormat = getAnydocFormatByMimeType(input.mimeType)?.format;
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
  // Only conversion loads native code. Catalog and non-document parser
  // consumers do not require the binary merely by importing this package.
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
  // Supply the declared format for signature-less CSV and unrecognizable
  // containers; detected formats above must still match the declaration.
  // Explicit reject prevents ambient Firecrawl credentials from enabling uploads.
  const content = await toMarkdownBytes(
    input.content,
    expectedFormat as Format,
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
  return buildParsedDocument({
    parseInput: input,
    content,
    pages: [],
    metadata: {
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

export const anydocSourceParser = {
  id: "anydoc",
  name: "AnyDoc Document Parser",
  supportedMimeTypes: anydocMimeTypes,
  parse: parseWithAnydoc,
} as const;
