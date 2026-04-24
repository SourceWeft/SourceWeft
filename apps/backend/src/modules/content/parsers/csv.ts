import { createCsvLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";

export const csvSourceParser = createLoaderParser({
  id: "csv",
  name: "CSV Parser",
  supportedMimeTypes: ["text/csv", "application/csv"] as const,
  createLoader: (filePath) => createCsvLoader(filePath),
  mapPages: ({ docs, normalizeWhitespace }) =>
    docs
      .map((doc, index) => ({
        pageNumber: index + 1,
        content: normalizeWhitespace(doc.pageContent),
      }))
      .filter((page) => page.content.length > 0),
});
