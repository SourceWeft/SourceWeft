import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import { SEARCH_SOURCES_TOOL_NAME } from "./agent-tool-defs";
import { buildRetrievalToolDescription, formatRetrievalContext, type RetrievalChunk } from "./tool-format";

export { formatRetrievalContext, type RetrievalChunk };

export function createRetrievalTool(input: {
  searchSources: (
    query: string,
    runtime?: {
      toolCallId?: string;
      toolName?: string;
    },
  ) => Promise<readonly RetrievalChunk[]>;
}) {
  return tool(
    async ({ query }: { query: string }, runtime: ToolRuntime) => {
      const chunks = await input.searchSources(query, {
        toolCallId: runtime.toolCallId,
        toolName: SEARCH_SOURCES_TOOL_NAME,
      });
      return formatRetrievalContext(chunks);
    },
    {
      name: SEARCH_SOURCES_TOOL_NAME,
      description: buildRetrievalToolDescription(),
      schema: z.object({
        query: z.string().min(1),
      }),
    },
  );
}
