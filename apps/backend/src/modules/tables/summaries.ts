import { and, eq, inArray } from "drizzle-orm";
import { db, sourceGuides, sources } from "@sourceweft/db";
import { GroundedGenerationError } from "@sourceweft/contracts/grounded-generation";

/** How much of a source's text stands in for its summary when it has no guide. */
export const SOURCE_SUMMARY_FALLBACK_CHARS = 1_200;

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  let result = "";
  for (const char of text) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

/**
 * What the column suggester reads of one source: its guide's summary when it
 * has one, else the first 1,200 characters of its text.
 */
export function pickSourceSummary(
  guideSummary: string | null | undefined,
  text: string,
): string {
  const summary = guideSummary?.trim();
  if (summary) return summary;
  return head(text.trim(), SOURCE_SUMMARY_FALLBACK_CHARS);
}

export type SourceSummary = { sourceId: string; title: string; summary: string };

/**
 * Titles and summaries of the selected sources, in selection order. Every
 * source must belong to this workspace (the workspace is the sharing
 * boundary), otherwise `SOURCE_NOT_READABLE`. A source that is not indexed yet
 * is still summarised from its text.
 */
export async function loadSourceSummaries(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<SourceSummary[]> {
  const sourceIds = [...new Set(input.sourceIds)];
  const scope = (table: typeof sources | typeof sourceGuides) =>
    and(
      eq(table.teamId, input.teamId),
      eq(table.workspaceId, input.workspaceId),
    );
  const rows = sourceIds.length
    ? await db
        .select({ id: sources.id, title: sources.title, text: sources.contentText })
        .from(sources)
        .where(and(scope(sources), inArray(sources.id, sourceIds)))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = sourceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new GroundedGenerationError(
      "SOURCE_NOT_READABLE",
      "Some selected sources do not exist in this workspace",
      { sourceIds: missing },
    );
  }
  const guides = await db
    .select({ sourceId: sourceGuides.sourceId, content: sourceGuides.contentJson })
    .from(sourceGuides)
    .where(and(scope(sourceGuides), inArray(sourceGuides.sourceId, sourceIds)));
  const guideSummary = new Map(
    guides.map((guide) => [guide.sourceId, guide.content?.summary ?? null]),
  );
  return sourceIds.map((id) => {
    const row = byId.get(id)!;
    return {
      sourceId: id,
      title: row.title,
      summary: pickSourceSummary(guideSummary.get(id), row.text),
    };
  });
}
