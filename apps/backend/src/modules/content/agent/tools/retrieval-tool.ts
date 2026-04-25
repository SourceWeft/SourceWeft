import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

export type RetrievalChunk = {
  citation: string;
  chunkId: string;
  content: string;
  sourceTitle?: string;
};

export function formatRetrievalContext(chunks: RetrievalChunk[]) {
  if (chunks.length === 0) {
    return "No relevant evidence was found.";
  }

  return `Use these source chunks internally. Every factual claim from these chunks MUST cite the exact chunk id as [citation:cN]. cN is the id attribute from the chunk tag.

Before finalizing your answer, verify every sentence or bullet that uses these chunks ends with one or more markers like [citation:c1]. Do not omit citation markers.

${chunks
    .map(
      (chunk) =>
        `<chunk id='${chunk.citation}' source_chunk_id='${chunk.chunkId}' source_title='${chunk.sourceTitle ?? "Untitled source"}'>${chunk.content.replace(/\s+/g, " ").trim().slice(0, 1000)}</chunk>`,
    )
    .join("\n\n")}`;
}

export function createRetrievalTool(input: {
  retrieve: (
    query: string,
    runtime?: {
      toolCallId?: string;
    },
  ) => Promise<RetrievalChunk[]>;
}) {
  return tool(
    async ({ query }: { query: string }, runtime: ToolRuntime) => {
      const chunks = await input.retrieve(query, {
        toolCallId: runtime.toolCallId,
      });
      return formatRetrievalContext(chunks);
    },
    {
      name: "retrieve",
      description:
        "Search the current workspace knowledge base for relevant chunks before answering.",
      schema: z.object({
        query: z.string().min(1),
      }),
    },
  );
}
