import { createTextLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";

export const textSourceParser = createLoaderParser({
  id: "text",
  name: "Text Parser",
  supportedMimeTypes: [
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/html",
    "application/xml",
    "text/xml",
  ] as const,
  createLoader: (filePath) => createTextLoader(filePath),
});
