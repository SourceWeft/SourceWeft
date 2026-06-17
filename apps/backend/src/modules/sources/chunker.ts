import { chunkSourceContent as packageChunkSourceContent } from "@sourceweft/builtin-document-parsers";
import type { ChunkSpec, ParsingConfig } from "./types";

export async function chunkSourceContent(
  contentText: string,
  config?: Pick<ParsingConfig, "chunkSize"> | null,
): Promise<ChunkSpec[]> {
  const chunks = await packageChunkSourceContent(contentText, config);
  return chunks.map((chunk) => ({
    text: chunk.text,
    startIndex: chunk.startIndex,
    endIndex: chunk.endIndex,
    tokenCount: chunk.tokenCount,
    ...(chunk.embedding ? { embedding: [...chunk.embedding] } : {}),
  }));
}
