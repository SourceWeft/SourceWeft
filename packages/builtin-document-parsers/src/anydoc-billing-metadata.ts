import { ParserContentError } from "./errors";
import { withTempFile } from "./file-buffer";
import { normalizeWhitespace } from "./text-utils";
import { getAnydocFormatByMimeType } from "./anydoc-formats";
import type { ParseInput } from "./types";

/** Accounting metadata only; document extraction belongs exclusively to AnyDoc.
 * Preserve pre-migration CSV row and EPUB nonempty chapter billing semantics
 * with the same low-level readers, without loading a legacy document parser.
 */
export async function readAnydocBillingMetadata(input: ParseInput): Promise<
  | {
      billingPageCount: number;
      billingPageCountSource: "csv-records" | "epub-chapters" | "document";
    }
  | undefined
> {
  const format = getAnydocFormatByMimeType(input.mimeType)?.format;
  if (!format || format === "pdf") return undefined;
  if (format === "csv") {
    const { csvParse } = await import("d3-dsv");
    // CSVLoader used the same comma parser over trimmed UTF-8 input. Even
    // empty-valued rows counted because their old content contained headers.
    return countMetadata(
      csvParse(input.content.toString("utf8").trim()).length,
      "csv-records",
    );
  }
  if (format === "epub") {
    const [{ EPub }, { htmlToText }] = await Promise.all([
      import("epub2"),
      import("html-to-text"),
    ]);
    const count = await withTempFile({
      fileName: input.fileName,
      content: input.content,
      run: async (path) => {
        const epub = await EPub.createAsync(path);
        let count = 0;
        for (const chapter of epub.flow) {
          if (!chapter.id) continue;
          const html = await epub.getChapterRawAsync(chapter.id);
          if (html && normalizeWhitespace(htmlToText(html)).length > 0)
            count += 1;
        }
        return count;
      },
    });
    return countMetadata(count, "epub-chapters");
  }
  // Existing DOC/DOCX/PPTX used one document unit, not a physical page count.
  // Newly supported office/RTF formats use that same document billing unit.
  return { billingPageCount: 1, billingPageCountSource: "document" };
}

function countMetadata(
  billingPageCount: number,
  billingPageCountSource: "csv-records" | "epub-chapters",
) {
  if (billingPageCount === 0) {
    throw new ParserContentError(
      422,
      "ANYDOC_NO_INDEXABLE_RECORDS",
      "Document contains no indexable records or chapters.",
    );
  }
  return { billingPageCount, billingPageCountSource };
}
