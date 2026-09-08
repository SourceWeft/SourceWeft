import { ParserContentError } from "./errors";
import { createCsvLoader, createEpubLoader } from "./langchain-loaders";
import { withTempFile } from "./file-buffer";
import { normalizeWhitespace } from "./text-utils";
import type { ParseInput } from "./types";

/** Preserve the pre-migration billing unit count, independently of citations.
 * CSV/EPUB deliberately run the existing loader for accounting metadata only;
 * its content is never substituted for AnyDoc output, even on failure.
 */
export async function readAnydocBillingMetadata(input: ParseInput): Promise<
  | {
      billingPageCount: number;
      billingPageCountSource: "legacy-loader" | "document";
    }
  | undefined
> {
  if (
    input.mimeType === "text/csv" ||
    input.mimeType === "application/csv" ||
    input.mimeType === "application/epub+zip"
  ) {
    const docs =
      input.mimeType === "application/epub+zip"
        ? await withTempFile({
            fileName: input.fileName,
            content: input.content,
            run: (path) => createEpubLoader(path).load(),
          })
        : await createCsvLoader(
            new Blob([new Uint8Array(input.content)]),
          ).load();
    const billingPageCount = docs.filter(
      (doc) => normalizeWhitespace(doc.pageContent).length > 0,
    ).length;
    if (billingPageCount === 0) {
      throw new ParserContentError(
        422,
        "ANYDOC_NO_INDEXABLE_RECORDS",
        "Document contains no indexable records or chapters.",
      );
    }
    return {
      billingPageCount,
      billingPageCountSource: "legacy-loader",
    };
  }
  if (
    input.mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    input.mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return { billingPageCount: 1, billingPageCountSource: "document" };
  }
  return undefined;
}
