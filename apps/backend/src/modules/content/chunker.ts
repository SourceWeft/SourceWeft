import { RecursiveChunker, RecursiveRules } from "@chonkiejs/core";
import type { ParsingConfig } from "./types";

let defaultChunkerPromise: Promise<RecursiveChunker> | null = null;

const documentRules = new RecursiveRules({
  levels: [
    { delimiters: ["\n\n", "\r\n", "\n", "\r"] },
    { delimiters: [". ", "! ", "? "] },
    {},
  ],
});

function getChunkSize(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  return config?.chunkSize ?? 512;
}

function getDefaultChunker(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  const chunkSize = getChunkSize(config);

  if (config?.chunkSize) {
    return RecursiveChunker.create({
      chunkSize,
      minCharactersPerChunk: 50,
      rules: documentRules,
    });
  }

  if (!defaultChunkerPromise) {
    defaultChunkerPromise = RecursiveChunker.create({
      chunkSize,
      minCharactersPerChunk: 50,
      rules: documentRules,
    });
  }

  return defaultChunkerPromise;
}

export async function chunkSourceContent(
  contentText: string,
  config?: Pick<ParsingConfig, "chunkSize"> | null,
) {
  const normalized = contentText.trim();
  if (!normalized) {
    return [];
  }

  const chunker = await getDefaultChunker(config);
  const chunks = await chunker.chunk(normalized);

  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}
