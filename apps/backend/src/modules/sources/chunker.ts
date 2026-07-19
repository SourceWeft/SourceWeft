import {
  chunkSourceContent as packageChunkSourceContent,
  type ChunkSpec,
  type ParsingConfig,
} from "@sourceweft/builtin-document-parsers";

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
