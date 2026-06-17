import {
  SEARCH_SOURCES_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  LS_TOOL_NAME,
  GLOB_TOOL_NAME,
} from "@sourceweft/contracts/agent-tools";

export type RetrievalChunk = {
  readonly citation: string;
  readonly chunkId: string;
  readonly content: string;
  readonly sourceTitle?: string;
};

function compactChunkContent(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function escapeChunkText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatRetrievalContext(chunks: readonly RetrievalChunk[]) {
  if (chunks.length === 0) {
    return `No relevant evidence was found. Try ${SEARCH_SOURCES_TOOL_NAME} again only if a substantially different query could locate missing evidence; otherwise use ${GREP_TOOL_NAME} only for explicit literal matching or ${READ_FILE_TOOL_NAME} for surrounding context.`;
  }

  return `Use these source chunks internally. Every factual claim from these chunks MUST cite the exact citation id in the form [citation:cN]. cN is the id attribute from the chunk tag. If your final answer uses these chunks and contains zero exact [citation:id] markers, the answer is invalid.

Before finalizing your answer, verify every sentence, bullet, or source-grounded markdown table value cell that uses these chunks ends with one or more exact [citation:id] markers. If any source-grounded sentence or bullet has no marker, rewrite it before finalizing. In tables, cite the value cell that contains the supported fact; do not place all table citations only before or after the table. Do not omit citation markers. Never shorten citations to [id], never use numeric references, footnotes, markdown links, or a references section.

If these chunks answer the user's targeted question, answer directly with citations. Do not call ${SEARCH_SOURCES_TOOL_NAME} again with a similar query. Use ${READ_FILE_TOOL_NAME} only when surrounding context is needed, or ${GREP_TOOL_NAME} only for explicit literal matching or exact textual verification.

If the provided evidence does not directly support the requested value, entity, date, amount, decision, or relationship, state that the selected sources do not contain enough evidence. Do not infer a concrete answer from conditional, generic, templated, or procedural text.

${chunks
  .map(
    (chunk) =>
      `<chunk id='${escapeChunkText(chunk.citation)}' source_chunk_id='${escapeChunkText(chunk.chunkId)}' source_title='${escapeChunkText(chunk.sourceTitle ?? "Untitled source")}'>${escapeChunkText(compactChunkContent(chunk.content))}</chunk>`,
  )
  .join("\n\n")}`;
}

export function buildRetrievalToolDescription() {
  return `Search the current turn's selected source tree scope for relevant citable chunks. If a directory is selected, this includes the directory source and descendant indexed sources. This is the default first tool for targeted source-grounded Q&A, targeted extraction, field lookup, local fact lookup, semantic lookup, and finding relevant passages. Use ${SEARCH_SOURCES_TOOL_NAME} before ${LS_TOOL_NAME}, ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, or ${READ_FILE_TOOL_NAME} when the user asks a targeted question about selected, referenced, uploaded, attached, current, or workspace-specific sources. If ${SEARCH_SOURCES_TOOL_NAME} returns chunks that answer the targeted question, answer with citations instead of calling ${SEARCH_SOURCES_TOOL_NAME} again with a similar query. Use ${READ_FILE_TOOL_NAME} when surrounding context or source-wide coverage is needed. Use ${GREP_TOOL_NAME} only when the user explicitly asks for literal text matching, occurrence/location search, or when exact textual verification is needed after ${SEARCH_SOURCES_TOOL_NAME}. Search again only when the evidence is insufficient, ambiguous, conflicting, or missing a required field. Do not use ${SEARCH_SOURCES_TOOL_NAME} first for source-wide coverage tasks such as summarizing, reviewing, comparing, listing document contents, or analyzing full selected sources/directories; use ${LS_TOOL_NAME}/${READ_FILE_TOOL_NAME} for those tasks. In final answers, refer to evidence as sources or selected sources.`;
}
