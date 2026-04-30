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
    return "No relevant evidence was found. Try search_sources again only if a substantially different query could locate missing evidence; otherwise use grep only for explicit literal matching or read_file for surrounding context.";
  }

  return `Use these source chunks internally. Every factual claim from these chunks MUST cite the exact citation id in the form [citation:cN]. cN is the id attribute from the chunk tag.

Before finalizing your answer, verify every sentence, bullet, or source-grounded markdown table value cell that uses these chunks ends with one or more exact [citation:id] markers. In tables, cite the value cell that contains the supported fact; do not place all table citations only before or after the table. Do not omit citation markers. Never shorten citations to [id], never use numeric references, footnotes, markdown links, or a references section.

If these chunks answer the user's targeted question, answer directly with citations. Do not call search_sources again with a similar query. Use read_file only when surrounding context is needed, or grep only for explicit literal matching or exact textual verification.

${chunks
    .map(
      (chunk) =>
        `<chunk id='${chunk.citation}' source_chunk_id='${chunk.chunkId}' source_title='${chunk.sourceTitle ?? "Untitled source"}'>${chunk.content.replace(/\s+/g, " ").trim().slice(0, 1000)}</chunk>`,
    )
    .join("\n\n")}`;
}

export function createRetrievalTool(input: {
  searchSources: (
    query: string,
    runtime?: {
      toolCallId?: string;
    },
  ) => Promise<RetrievalChunk[]>;
}) {
  return tool(
    async ({ query }: { query: string }, runtime: ToolRuntime) => {
      const chunks = await input.searchSources(query, {
        toolCallId: runtime.toolCallId,
      });
      return formatRetrievalContext(chunks);
    },
    {
      name: "search_sources",
      description:
        "Search the current turn's selected sources for relevant citable chunks. This is the default first tool for targeted source-grounded Q&A, targeted extraction, field lookup, local fact lookup, semantic lookup, and finding relevant passages. Use search_sources before ls, glob, grep, or read_file when the user asks a targeted question about selected, referenced, uploaded, attached, current, or workspace-specific sources. If search_sources returns chunks that answer the targeted question, answer with citations instead of calling search_sources again with a similar query. Use read_file when surrounding context or source-wide coverage is needed. Use grep only when the user explicitly asks for literal text matching, occurrence/location search, or when exact textual verification is needed after search_sources. Search again only when the evidence is insufficient, ambiguous, conflicting, or missing a required field. Do not use search_sources first for source-wide coverage tasks such as summarizing, reviewing, comparing, listing document contents, or analyzing full selected sources; use ls/read_file for those tasks. In final answers, refer to evidence as sources or selected sources.",
      schema: z.object({
        query: z.string().min(1),
      }),
    },
  );
}
