import { createSrtLoader } from "./langchain-loaders";
import { createLoaderParser } from "./loader-parser";
import type { SourceParser } from "./types";

export const srtSourceParser: SourceParser = createLoaderParser({
  id: "srt",
  name: "SRT Parser",
  supportedMimeTypes: [
    "application/x-subrip",
    "text/srt",
    "application/srt",
  ] as const,
  createLoader: (filePath) => createSrtLoader(filePath),
});
