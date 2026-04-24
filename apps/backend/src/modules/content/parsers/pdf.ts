import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { createLoaderParser } from "./loader-parser";

export const pdfSourceParser = createLoaderParser({
  id: "pdf",
  name: "PDF Parser",
  supportedMimeTypes: ["application/pdf"] as const,
  createLoader: (filePath) => new PDFLoader(filePath, { splitPages: true }),
  mapPages: ({ docs, normalizeWhitespace }) =>
    docs
      .map((doc) => {
        const content = normalizeWhitespace(doc.pageContent);
        if (!content) {
          return null;
        }

        const loc = doc.metadata?.loc as { pageNumber?: number } | undefined;
        return {
          pageNumber: loc?.pageNumber ?? 1,
          content,
        };
      })
      .filter((page): page is { pageNumber: number; content: string } => page !== null),
  getPageCount: ({ docs, pages }) => {
    const pdfMeta = docs[0]?.metadata?.pdf as { totalPages?: number } | undefined;
    return pdfMeta?.totalPages ?? pages.length;
  },
});
