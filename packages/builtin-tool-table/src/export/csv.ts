import type { TableContent } from "@sourceweft/contracts/table";

export type TableCsvLabels = {
  /** Header of the first column, which holds the source title. */
  readonly source: string;
  /** Appended to a column name to head its evidence column ("<name> <suffix>"). */
  readonly evidenceSuffix: string;
  /**
   * Accepted so one label set serves every export format. A CSV leaves
   * `not_found` and `unverified` cells empty instead of writing a label.
   */
  readonly notFound?: string;
  readonly unverified?: string;
};

export type TableCsvOptions = {
  readonly includeEvidence: boolean;
  readonly labels: TableCsvLabels;
};

type CsvFieldSpec = { text: string; plainNumber?: boolean };

const BOM = "﻿";
const EOL = "\r\n";

/**
 * Spreadsheet apps run a cell that starts with one of these as a formula, and
 * source titles, column names and quotes are all text a third party wrote.
 * A leading single quote makes the app read the cell as text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A plain number cannot run as a formula, and a leading quote would stop a
 * spreadsheet from reading it as a number: optional minus, digits with optional
 * thousands commas or a decimal part, optional percent sign, nothing else.
 */
const PLAIN_NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

/** RFC 4180 field: quoted when it holds a separator, quote or line break. */
function csvField(raw: string, plainNumber = false) {
  const guard = FORMULA_LEAD.test(raw) && !(plainNumber && PLAIN_NUMBER.test(raw));
  const value = guard ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * A table as CSV: UTF-8 BOM (so Excel reads it as UTF-8), CRLF line breaks, the
 * source title first, then one column per table column. A cell the source did
 * not confirm (`not_found`, `unverified`) is empty, and so is every cell of a
 * `failed` or `skipped` row. A `number` cell exports `value`, the source's own
 * notation, never the `normalized` number.
 */
export function tableToCsv(content: TableContent, options: TableCsvOptions): string {
  const { includeEvidence, labels } = options;
  const header = [labels.source];
  for (const column of content.columns) {
    header.push(column.name);
    if (includeEvidence) header.push(`${column.name} ${labels.evidenceSuffix}`);
  }
  const rows = content.rows.map((row) => {
    const fields: CsvFieldSpec[] = [{ text: row.title }];
    for (const column of content.columns) {
      const cell = row.cells[column.id];
      const found = cell?.status === "found" ? cell : null;
      fields.push({
        text: found ? found.value : "",
        plainNumber: column.type === "number",
      });
      if (includeEvidence) {
        fields.push({ text: found ? (found.evidence[0]?.quote ?? "") : "" });
      }
    }
    return fields;
  });
  return (
    BOM + [header.map((text): CsvFieldSpec => ({ text })), ...rows]
      .map((fields) => fields.map((f) => csvField(f.text, f.plainNumber)).join(",") + EOL)
      .join("")
  );
}
