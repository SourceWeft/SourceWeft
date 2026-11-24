import { TABLE_LIMITS, type TableColumn } from "@sourceweft/contracts/table";
import type { TableFigurePort } from "@sourceweft/contracts/table-capability";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import { matchesOutputLanguage } from "@sourceweft/grounded-generation";
import { coverDate, extractFigures, parseBoolean } from "./normalize";
import type { RawCell } from "./schemas";

/** What the model said about one column in one group of one source. */
export type ReadEntry =
  | { kind: "absent" }
  /** The model claims a value but did not back it in a usable way. */
  | { kind: "invalid" }
  | { kind: "claim"; value: string; handle: string; quote: string | null };

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Sorts one answer entry. A claim must have a value within the cell limit and
 * a handle of a chunk of THIS source; a handle that names a chunk of another
 * source (or no chunk at all) makes the claim invalid, so another source's text
 * is never attached to this row.
 */
export function readEntry(entry: RawCell, ownHandles: ReadonlySet<string>): ReadEntry {
  if (!entry.found) return { kind: "absent" };
  const value = tidy(entry.value ?? "");
  const handle = entry.chunk?.trim() ?? "";
  if (value.length === 0 || value.length > TABLE_LIMITS.cellChars) return { kind: "invalid" };
  if (!ownHandles.has(handle)) return { kind: "invalid" };
  const quote = tidy(entry.quote ?? "");
  return { kind: "claim", value, handle, quote: quote.length > 0 ? quote : null };
}

/**
 * The text the anchor port must find in the cited chunk: the value and, on its
 * own line, the passage the model says it copied. Either may anchor the claim;
 * the evidence stored is the source's own text the port found, never the
 * model's wording.
 */
export function anchorTextOf(claim: { value: string; quote: string | null }): string {
  return claim.quote ? `${claim.value}\n${claim.quote}` : claim.value;
}

/**
 * The type rule of a column, checked against the anchored evidence (source
 * text), never against what the model wrote. Returns the value the cell keeps,
 * or undefined when the rule fails:
 * - number: the value states at least one figure and every figure appears in
 *   the passage, in whatever notation (the host's figure port decides);
 * - date: the value reads as a date and the passage states that date; a value
 *   more precise than the passage is kept at the passage's precision
 *   (`coverDate`), so `2025-12-31` backed by "截至2025年末" is kept as `2025`;
 * - boolean: the value reads as yes or no;
 * - text: nothing beyond anchoring.
 * Every type but date keeps the value exactly as written.
 * The figure port sees width-normalised text so full-width digits count.
 */
export function keptValue(
  column: Pick<TableColumn, "type">,
  value: string,
  evidence: readonly GroundedEvidence[],
  figures: TableFigurePort,
): string | undefined {
  const passage = evidence.map((entry) => entry.quote).join("\n");
  switch (column.type) {
    case "number":
      return extractFigures(value).length > 0 &&
        figures.covered(value.normalize("NFKC"), passage.normalize("NFKC"))
        ? value
        : undefined;
    case "date":
      return coverDate(value, passage);
    case "boolean":
      return parseBoolean(value) !== undefined ? value : undefined;
    case "text":
      return value;
  }
}

/**
 * The answer is in the requested language. Only text columns carry language;
 * the values of one answer are judged together, so a proper noun in an
 * otherwise Chinese answer does not fail it. Cells are short and the prompt
 * keeps names, codes and quotations in their original form, so a Latin word
 * counts as one unit for Chinese output, not one per letter.
 */
export function answerMatchesLanguage(
  entries: readonly RawCell[],
  columns: ReadonlyMap<string, Pick<TableColumn, "type">>,
  language: string,
): boolean {
  const text = entries
    .filter((entry) => entry.found && columns.get(entry.columnId)?.type === "text")
    .map((entry) => entry.value ?? "")
    .join(" ");
  return matchesOutputLanguage(text, language, { latinWordUnits: true });
}
