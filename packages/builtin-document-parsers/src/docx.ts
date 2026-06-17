import { createDocxLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";
import type { SourceParser } from "./types";

export const docxSourceParser: SourceParser = createLoaderParser({
  id: "docx",
  name: "DOCX Parser",
  supportedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
  ] as const,
  createLoader: (filePath, fileName) => createDocxLoader(filePath, fileName),
});
