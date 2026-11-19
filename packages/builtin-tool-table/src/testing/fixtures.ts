import {
  tableCellFingerprint,
  tableColumnFingerprint,
  type TableCell,
  type TableColumn,
  type TableContent,
  type TableRow,
} from "@sourceweft/contracts/table";

/**
 * Two small, deterministic tables for tests and previews: one English, one
 * Chinese. Each has 2 sources and 3 columns (text, number, date) and holds
 * `found`, `not_found` and `unverified` cells. Row 1 of each is complete; row 2
 * has the gaps, so the second source is the natural one to mark stale.
 *
 * Plain `TableContent` objects: they parse with `tableContentSchema`, and their
 * fingerprints are computed with the contract functions, so a fill plan sees
 * their `found` and `not_found` cells as reusable.
 */

const hex = (n: number) => n.toString(16).padStart(32, "0");
const SHA = `sha256:${"a".repeat(64)}`;

type Seed = {
  language: string;
  promptVersion: string;
  columns: { suffix: number; name: string; description: string; type: TableColumn["type"] }[];
  sources: { key: string; title: string; contentHash: string }[];
};

function columnsOf(seed: Seed): TableColumn[] {
  return seed.columns.map((column) => ({
    id: `col_${hex(column.suffix)}`,
    name: column.name,
    description: column.description,
    type: column.type,
    fingerprint: tableColumnFingerprint(column),
  }));
}

function cellFingerprint(
  seed: Seed,
  column: TableColumn,
  source: Seed["sources"][number],
) {
  return tableCellFingerprint({
    columnFingerprint: column.fingerprint,
    contentHash: source.contentHash,
    promptVersion: seed.promptVersion,
    language: seed.language,
  });
}

function found(
  seed: Seed,
  column: TableColumn,
  source: Seed["sources"][number],
  value: string,
  quote: string,
  normalized?: number | string | boolean,
): TableCell {
  return {
    status: "found",
    value,
    ...(normalized === undefined ? {} : { normalized }),
    evidence: [
      {
        kind: "chunk",
        sourceId: `src-${source.key}`,
        documentId: `doc-${source.key}`,
        chunkId: `chunk-${source.key}-1`,
        chunkNo: 1,
        headingPath: null,
        quote,
        startChar: 0,
        endChar: quote.length,
        quoteHash: SHA,
      },
    ],
    fingerprint: cellFingerprint(seed, column, source),
  };
}

function gap(
  seed: Seed,
  status: "not_found" | "unverified",
  column: TableColumn,
  source: Seed["sources"][number],
): TableCell {
  return { status, fingerprint: cellFingerprint(seed, column, source) };
}

function build(
  seed: Seed,
  fill: (
    columns: TableColumn[],
    sources: Seed["sources"],
  ) => Record<string, TableCell>[],
): TableContent {
  const columns = columnsOf(seed);
  const cellsByRow = fill(columns, seed.sources);
  const rows: TableRow[] = seed.sources.map((source, index) => ({
    id: `r_${hex(index + 1)}`,
    sourceId: `src-${source.key}`,
    documentId: `doc-${source.key}`,
    title: source.title,
    contentHash: source.contentHash,
    status: "ok",
    cells: cellsByRow[index]!,
  }));
  return {
    schemaVersion: 1,
    kind: "table",
    language: seed.language,
    columns,
    rows,
    generation: {
      promptVersion: seed.promptVersion,
      modelAlias: "test-model",
      stats: {
        sources: 2,
        columns: 3,
        found: 4,
        notFound: 1,
        unverified: 1,
        reusedCells: 0,
        failedRows: 0,
        skippedRows: 0,
        modelCalls: 2,
        tokensEstimated: 600,
      },
      recipe: {
        columns: columns.map(({ id, name, description, type }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          type,
        })),
        sourceIds: seed.sources.map((source) => `src-${source.key}`),
      },
    },
  };
}

const ENGLISH: Seed = {
  language: "en",
  promptVersion: "table-v1",
  columns: [
    { suffix: 1, name: "Study design", description: "How the study was run", type: "text" },
    { suffix: 2, name: "Sample size", description: "Number of participants", type: "number" },
    { suffix: 3, name: "Published", description: "Publication date", type: "date" },
  ],
  sources: [
    { key: "atlas", title: "Atlas trial report", contentHash: "hash-atlas-v1" },
    { key: "beacon", title: "Beacon cohort study", contentHash: "hash-beacon-v1" },
  ],
};

/** English table: row 2 has a `not_found` and an `unverified` cell. */
export const TABLE_FIXTURE_EN: TableContent = build(ENGLISH, ([design, size, published], [atlas, beacon]) => [
  {
    [design!.id]: found(
      ENGLISH,
      design!,
      atlas!,
      "Randomised controlled trial",
      "This was a randomised controlled trial.",
    ),
    [size!.id]: found(
      ENGLISH,
      size!,
      atlas!,
      "1,200 participants",
      "Enrolment reached 1,200 participants.",
      1200,
    ),
    [published!.id]: found(
      ENGLISH,
      published!,
      atlas!,
      "March 5, 2024",
      "Published on March 5, 2024.",
      "2024-03-05",
    ),
  },
  {
    [design!.id]: found(
      ENGLISH,
      design!,
      beacon!,
      "Prospective cohort",
      "A prospective cohort followed adults for ten years.",
    ),
    [size!.id]: gap(ENGLISH, "unverified", size!, beacon!),
    [published!.id]: gap(ENGLISH, "not_found", published!, beacon!),
  },
]);

const CHINESE: Seed = {
  language: "zh-CN",
  promptVersion: "table-v1",
  columns: [
    { suffix: 11, name: "研究设计", description: "研究如何开展", type: "text" },
    { suffix: 12, name: "样本量", description: "参与者人数", type: "number" },
    { suffix: 13, name: "发布日期", description: "发表日期", type: "date" },
  ],
  sources: [
    { key: "atlas-zh", title: "阿特拉斯试验报告", contentHash: "hash-atlas-zh-v1" },
    { key: "beacon-zh", title: "灯塔队列研究", contentHash: "hash-beacon-zh-v1" },
  ],
};

/** Chinese table: row 2 has a `not_found` and an `unverified` cell. */
export const TABLE_FIXTURE_ZH: TableContent = build(CHINESE, ([design, size, published], [atlas, beacon]) => [
  {
    [design!.id]: found(CHINESE, design!, atlas!, "随机对照试验", "这是一项随机对照试验。"),
    [size!.id]: found(CHINESE, size!, atlas!, "1200 名参与者", "共纳入 1200 名参与者。", 1200),
    [published!.id]: found(
      CHINESE,
      published!,
      atlas!,
      "2024年3月5日",
      "报告发布于 2024年3月5日。",
      "2024-03-05",
    ),
  },
  {
    [design!.id]: found(CHINESE, design!, beacon!, "前瞻性队列研究", "这是一项前瞻性队列研究。"),
    [size!.id]: gap(CHINESE, "not_found", size!, beacon!),
    [published!.id]: gap(CHINESE, "unverified", published!, beacon!),
  },
]);
