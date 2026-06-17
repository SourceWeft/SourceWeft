import { createPptxLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";
import type { SourceParser } from "./types";

export const pptxSourceParser: SourceParser = createLoaderParser({
  id: "pptx",
  name: "PPTX Parser",
  supportedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ] as const,
  createLoader: (filePath) => createPptxLoader(filePath),
});
