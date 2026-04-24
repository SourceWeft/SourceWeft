import { createEpubLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";

export const epubSourceParser = createLoaderParser({
  id: "epub",
  name: "EPUB Parser",
  supportedMimeTypes: ["application/epub+zip"] as const,
  createLoader: (filePath) => createEpubLoader(filePath),
  mapPages: ({ docs, normalizeWhitespace }) =>
    docs
      .map((doc, index) => ({
        pageNumber: index + 1,
        content: normalizeWhitespace(doc.pageContent),
      }))
      .filter((page) => page.content.length > 0),
});
