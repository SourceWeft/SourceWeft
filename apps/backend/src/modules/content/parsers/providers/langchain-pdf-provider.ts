import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { withTempFile } from "../file-buffer";
import type { DocumentParseProvider, ProviderParseInput } from "./types";
import { buildParsedDocument, normalizeWhitespace } from "./utils";

export const langChainPdfProvider: DocumentParseProvider = {
  id: "langchain",
  supports(mimeType) {
    return mimeType === "application/pdf";
  },
  async start(input: ProviderParseInput) {
    const document = await withTempFile({
      fileName: input.fileName,
      content: input.content,
      run: async (filePath) => {
        const loader = new PDFLoader(filePath, { splitPages: true });
        const docs = await loader.load();
        const pages = docs
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
          .filter((page): page is { pageNumber: number; content: string } => page !== null);
        const content = pages.map((page) => page.content).join("\n\n");
        const pdfMeta = docs[0]?.metadata?.pdf as { totalPages?: number } | undefined;

        return buildParsedDocument({
          parseInput: input,
          content,
          pages,
          metadata: {
            pageCount: pdfMeta?.totalPages ?? pages.length,
            documentParseProviderResolved: "langchain",
            documentParseProvider: "langchain",
            documentParseBackend: "langchain",
            documentParseMode: "pure_text_pdf",
          },
        });
      },
    });

    return { kind: "completed", document };
  },
};
