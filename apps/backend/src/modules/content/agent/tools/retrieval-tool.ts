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
        "Search indexed workspace knowledge for relevant citable chunks. When sources are selected for the current turn, search is already scoped to those sources. Use this directly and first for source-grounded Q&A, targeted extraction, field-value extraction, local fact lookup, semantic lookup, and finding relevant passages across sources. Questions like 'what is the registered domain?', 'what is the invoice number?', 'when does it expire?', or 'how much is it?' should use retrieve before ls, glob, or grep. Do not call ls, glob, or grep first just to discover selected source paths or try keyword guesses. Do not use retrieve first for source-wide coverage tasks such as summarizing, reviewing, comparing, listing document contents, or analyzing full selected sources; use ls/read_file for those tasks.",
      schema: z.object({
        query: z.string().min(1),
      }),
    },
  );
}
