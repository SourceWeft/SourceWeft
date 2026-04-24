import { createSrtLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";

export const srtSourceParser = createLoaderParser({
  id: "srt",
  name: "SRT Parser",
  supportedMimeTypes: [
    "application/x-subrip",
    "text/srt",
    "application/srt",
  ] as const,
  createLoader: (filePath) => createSrtLoader(filePath),
});
