import { RecursiveChunker } from "@chonkiejs/core";
import type { ParsingConfig } from "./types";

let defaultChunkerPromise: Promise<RecursiveChunker> | null = null;

function getDefaultChunker(config?: Pick<ParsingConfig, "chunkSize"> | null) {
  if (config?.chunkSize) {
    return RecursiveChunker.create({
      chunkSize: config.chunkSize,
      minCharactersPerChunk: 50,
    });
  }

  if (!defaultChunkerPromise) {
    defaultChunkerPromise = RecursiveChunker.create({
      chunkSize: 512,
      minCharactersPerChunk: 50,
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
  return chunker.chunk(normalized);
}

