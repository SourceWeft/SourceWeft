import type { TableContent } from "@sourceweft/contracts/table";

export type TableMarkdownLabels = {
  readonly source: string;
  readonly notFound: string;
  readonly unverified: string;
};

/** A pipe would end the cell and a line break would end the row. */
function markdownCell(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

/**
 * A table as a GitHub-flavoured Markdown table. `not_found` and `unverified`
 * cells carry the caller's labels; a `failed` or `skipped` row keeps its title
 * with empty cells.
 */
export function tableToMarkdown(
  content: TableContent,
  labels: TableMarkdownLabels,
): string {
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell) => markdownCell(cell).trim()).join(" | ")} |`;
  const out = [
    line([labels.source, ...content.columns.map((column) => column.name)]),
    line(["---", ...content.columns.map(() => "---")]),
  ];
  for (const row of content.rows) {
    out.push(
      line([
        row.title,
        ...content.columns.map((column) => {
          const cell = row.cells[column.id];
          if (!cell) return "";
          if (cell.status === "found") return cell.value;
          return cell.status === "not_found" ? labels.notFound : labels.unverified;
        }),
      ]),
    );
  }
  return `${out.join("\n")}\n`;
}
