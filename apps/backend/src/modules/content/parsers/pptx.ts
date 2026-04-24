import { createPptxLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";

export const pptxSourceParser = createLoaderParser({
  id: "pptx",
  name: "PPTX Parser",
  supportedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ] as const,
  createLoader: (filePath) => createPptxLoader(filePath),
});
