import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import { AGENT_TOOL_NAMES } from "../tool-names";

export type RetrievalChunk = {
  citation: string;
  chunkId: string;
  content: string;
  sourceTitle?: string;
};

export function formatRetrievalContext(chunks: RetrievalChunk[]) {
  if (chunks.length === 0) {
    return `No relevant evidence was found. Try ${AGENT_TOOL_NAMES.searchSources} again only if a substantially different query could locate missing evidence; otherwise use ${AGENT_TOOL_NAMES.grep} only for explicit literal matching or ${AGENT_TOOL_NAMES.readFile} for surrounding context.`;
  }

  return `Use these source chunks internally. Every factual claim from these chunks MUST cite the exact citation id in the form [citation:cN]. cN is the id attribute from the chunk tag. If your final answer uses these chunks and contains zero exact [citation:id] markers, the answer is invalid.

Before finalizing your answer, verify every sentence, bullet, or source-grounded markdown table value cell that uses these chunks ends with one or more exact [citation:id] markers. If any source-grounded sentence or bullet has no marker, rewrite it before finalizing. In tables, cite the value cell that contains the supported fact; do not place all table citations only before or after the table. Do not omit citation markers. Never shorten citations to [id], never use numeric references, footnotes, markdown links, or a references section.

If these chunks answer the user's targeted question, answer directly with citations. Do not call ${AGENT_TOOL_NAMES.searchSources} again with a similar query. Use ${AGENT_TOOL_NAMES.readFile} only when surrounding context is needed, or ${AGENT_TOOL_NAMES.grep} only for explicit literal matching or exact textual verification.

If the provided evidence does not directly support the requested value, entity, date, amount, decision, or relationship, state that the selected sources do not contain enough evidence. Do not infer a concrete answer from conditional, generic, templated, or procedural text.

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
      name: AGENT_TOOL_NAMES.searchSources,
      description: `Search the current turn's selected source tree scope for relevant citable chunks. If a directory is selected, this includes the directory source and descendant indexed sources. This is the default first tool for targeted source-grounded Q&A, targeted extraction, field lookup, local fact lookup, semantic lookup, and finding relevant passages. Use ${AGENT_TOOL_NAMES.searchSources} before ${AGENT_TOOL_NAMES.ls}, ${AGENT_TOOL_NAMES.glob}, ${AGENT_TOOL_NAMES.grep}, or ${AGENT_TOOL_NAMES.readFile} when the user asks a targeted question about selected, referenced, uploaded, attached, current, or workspace-specific sources. If ${AGENT_TOOL_NAMES.searchSources} returns chunks that answer the targeted question, answer with citations instead of calling ${AGENT_TOOL_NAMES.searchSources} again with a similar query. Use ${AGENT_TOOL_NAMES.readFile} when surrounding context or source-wide coverage is needed. Use ${AGENT_TOOL_NAMES.grep} only when the user explicitly asks for literal text matching, occurrence/location search, or when exact textual verification is needed after ${AGENT_TOOL_NAMES.searchSources}. Search again only when the evidence is insufficient, ambiguous, conflicting, or missing a required field. Do not use ${AGENT_TOOL_NAMES.searchSources} first for source-wide coverage tasks such as summarizing, reviewing, comparing, listing document contents, or analyzing full selected sources/directories; use ${AGENT_TOOL_NAMES.ls}/${AGENT_TOOL_NAMES.readFile} for those tasks. In final answers, refer to evidence as sources or selected sources.`,
      schema: z.object({
        query: z.string().min(1),
      }),
    },
  );
}
