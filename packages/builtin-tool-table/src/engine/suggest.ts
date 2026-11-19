import {
  TABLE_LIMITS,
  type TableColumnInput,
} from "@sourceweft/contracts/table";
import {
  GroundedGenerationError,
  normalizeFingerprintText,
} from "@sourceweft/contracts/grounded-generation";
import type { TableGenerationMembers } from "@sourceweft/contracts/table-capability";
import {
  SUGGEST_MAX_COLUMNS,
  SUGGEST_MAX_OUTPUT_TOKENS,
  SUGGEST_SUMMARY_CHARS,
} from "./constants";
import { buildSuggestPrompt } from "./prompts";
import { readSuggestedColumn, readSuggestedEntries, SUGGEST_SCHEMA } from "./schemas";

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let result = "";
  for (const char of text) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

/**
 * Proposes the columns of a table from the sources' summaries. One structured
 * call, no source text beyond the summaries. The user's instruction and the
 * summaries travel in the user turn as data. The answer is cleaned (names cut
 * to the limit, duplicates by normalised name dropped, entries without a usable
 * name or type dropped, at most `SUGGEST_MAX_COLUMNS` kept); a model that
 * returns nothing usable fails loudly instead of yielding an empty suggestion.
 */
export const suggestColumns: TableGenerationMembers["suggestColumns"] = async (
  deps,
  input,
) => {
  const prompt = buildSuggestPrompt({
    ...(input.instruction ? { instruction: input.instruction } : {}),
    language: input.language,
    sources: input.sources.map((source) => ({
      title: source.title,
      summary: truncate(source.summary, SUGGEST_SUMMARY_CHARS),
    })),
  });
  const raw = await deps.model.completeStructured({
    operation: "table.columns.suggest",
    idempotencyKey: input.idempotencyKey,
    referenceId: input.referenceId,
    system: prompt.system,
    user: prompt.user,
    schema: SUGGEST_SCHEMA,
    maxTokens: SUGGEST_MAX_OUTPUT_TOKENS,
  });

  const columns: TableColumnInput[] = [];
  const seen = new Set<string>();
  for (const entry of readSuggestedEntries(raw)) {
    if (columns.length >= SUGGEST_MAX_COLUMNS) break;
    const parsed = readSuggestedColumn(entry);
    if (!parsed) continue;
    const name = truncate(parsed.name.trim(), TABLE_LIMITS.columnNameChars).trim();
    const key = normalizeFingerprintText(name);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    const description = truncate(
      parsed.description?.trim() ?? "",
      TABLE_LIMITS.columnDescriptionChars,
    ).trim();
    columns.push({
      name,
      ...(description ? { description } : {}),
      type: parsed.type,
    });
  }
  if (columns.length === 0) {
    throw new GroundedGenerationError(
      "GENERATION_QUALITY_TOO_LOW",
      "The model returned no usable column suggestion",
    );
  }
  return columns;
};
