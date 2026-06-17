import { createJsonLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";
import type { SourceParser } from "./types";

export const jsonSourceParser: SourceParser = createLoaderParser({
  id: "json",
  name: "JSON Parser",
  supportedMimeTypes: [
    "application/json",
    "application/jsonl",
    "application/x-ndjson",
  ] as const,
  createLoader: (filePath, _fileName) => createJsonLoader(filePath),
  mapPages: ({ docs, normalizeWhitespace }) =>
    docs
      .map((doc, index) => ({
        pageNumber: index + 1,
        content: normalizeWhitespace(doc.pageContent),
      }))
      .filter((page) => page.content.length > 0),
});
