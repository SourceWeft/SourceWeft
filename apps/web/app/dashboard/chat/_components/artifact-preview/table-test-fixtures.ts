import { parseTableContent, type TableContent } from "@sourceweft/contracts/table";

/**
 * Table payloads for the viewer tests: three sources by three columns with
 * found, not_found and unverified cells, one in English and one in Chinese.
 * Both go through `parseTableContent`, so a fixture that drifts from the
 * contract fails where it is built.
 */

const hex = (n: number, length: number) => n.toString(16).padStart(length, "0");
const columnId = (n: number) => `col_${hex(n, 32)}`;
const rowId = (n: number) => `r_${hex(n, 32)}`;
const fingerprint = (n: number) => hex(n, 16);

export const COLUMN_IDS = { price: columnId(1), launched: columnId(2), warranty: columnId(3) };

export function fixtureEvidence(quote: string, sourceNo: number) {
  return {
    kind: "chunk" as const,
    sourceId: `source-${sourceNo}`,
    documentId: `document-${sourceNo}`,
    chunkId: `chunk-${sourceNo}`,
    chunkNo: 1,
    headingPath: "Specifications > Details",
    quote,
    startChar: 0,
    endChar: quote.length,
    quoteHash: `sha256:${hex(sourceNo, 64)}`,
  };
}

type CellSpec =
  | { found: string; normalized?: number | string | boolean; quote: string }
  | "not_found"
  | "unverified";

function cell(spec: CellSpec, sourceNo: number, seed: number) {
  if (spec === "not_found") return { status: "not_found" as const, fingerprint: fingerprint(seed) };
  if (spec === "unverified") return { status: "unverified" as const, fingerprint: fingerprint(seed) };
  return {
    status: "found" as const,
    value: spec.found,
    ...(spec.normalized === undefined ? {} : { normalized: spec.normalized }),
    evidence: [fixtureEvidence(spec.quote, sourceNo)],
    fingerprint: fingerprint(seed),
  };
}

type RowSpec = {
  title: string;
  status?: "ok" | "failed" | "skipped";
  cells: [CellSpec, CellSpec, CellSpec];
};

export function buildTable(
  language: string,
  columnNames: [string, string, string],
  rowSpecs: RowSpec[],
): TableContent {
  const ids = [COLUMN_IDS.price, COLUMN_IDS.launched, COLUMN_IDS.warranty];
  const types = ["number", "date", "text"] as const;
  return parseTableContent({
    schemaVersion: 1,
    kind: "table",
    language,
    columns: columnNames.map((name, index) => ({
      id: ids[index],
      name,
      type: types[index],
      fingerprint: fingerprint(100 + index),
    })),
    rows: rowSpecs.map((spec, rowIndex) => ({
      id: rowId(rowIndex + 1),
      sourceId: `source-${rowIndex + 1}`,
      documentId: `document-${rowIndex + 1}`,
      title: spec.title,
      contentHash: `hash-${rowIndex + 1}`,
      status: spec.status ?? "ok",
      cells:
        (spec.status ?? "ok") === "ok"
          ? Object.fromEntries(
              spec.cells.map((value, columnIndex) => [
                ids[columnIndex],
                cell(value, rowIndex + 1, rowIndex * 10 + columnIndex),
              ]),
            )
          : {},
    })),
    generation: {
      promptVersion: "table-v1",
      modelAlias: "default-chat",
      stats: {
        sources: rowSpecs.length,
        columns: 3,
        found: 0,
        notFound: 0,
        unverified: 0,
        reusedCells: 0,
        failedRows: 0,
        skippedRows: 0,
        modelCalls: 0,
        tokensEstimated: 0,
      },
      recipe: {
        columns: columnNames.map((name, index) => ({
          id: ids[index],
          name,
          type: types[index],
        })),
        sourceIds: rowSpecs.map((_, index) => `source-${index + 1}`),
      },
    },
  });
}

export const tableFixtureEn = buildTable("en", ["Price", "Launch date", "Warranty"], [
  {
    title: "Alpha Phone",
    cells: [
      { found: "1,200 USD", normalized: 1200, quote: "The Alpha Phone costs 1,200 USD at launch." },
      { found: "March 3, 2024", normalized: "2024-03-03", quote: "It went on sale on March 3, 2024." },
      { found: "Two years", quote: "Every unit carries a two year warranty." },
    ],
  },
  {
    title: "Beta Phone",
    cells: [
      { found: "$950", normalized: 950, quote: "Beta Phone: $950." },
      "not_found",
      "unverified",
    ],
  },
  {
    title: "Gamma Phone",
    cells: [
      "not_found",
      { found: "June 1, 2023", normalized: "2023-06-01", quote: "Released June 1, 2023." },
      { found: "One year", quote: "Warranty: one year." },
    ],
  },
]);

export const tableFixtureZh = buildTable("zh-CN", ["价格", "发布日期", "保修"], [
  {
    title: "甲手机",
    cells: [
      { found: "一千二百元", normalized: 1200, quote: "甲手机首发定价一千二百元。" },
      { found: "2024年3月3日", normalized: "2024-03-03", quote: "于2024年3月3日开售。" },
      { found: "两年", quote: "整机享受两年保修。" },
    ],
  },
  {
    title: "乙手机",
    cells: [
      { found: "950元", normalized: 950, quote: "乙手机售价950元。" },
      "not_found",
      "unverified",
    ],
  },
  {
    title: "丙手机",
    cells: [
      "not_found",
      { found: "2023年6月1日", normalized: "2023-06-01", quote: "发布于2023年6月1日。" },
      { found: "一年", quote: "保修一年。" },
    ],
  },
]);
