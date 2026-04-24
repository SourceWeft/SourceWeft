import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

export type RetrievalChunk = {
  chunkId: string;
  content: string;
};

export function formatRetrievalContext(chunks: RetrievalChunk[]) {
  if (chunks.length === 0) {
    return `Context:
<chunk id="1"><![CDATA[No relevant context found.]]></chunk>`;
  }

  return `Context:
${chunks
    .map(
      (chunk, index) =>
        `<chunk id="${index + 1}"><![CDATA[${chunk.content.slice(0, 1000)}]]></chunk>`,
    )
    .join("\n")}`;
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
