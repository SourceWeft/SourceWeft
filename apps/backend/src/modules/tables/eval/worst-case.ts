import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  newTableColumnId,
  newTableRowId,
  tableCellFingerprint,
  tableColumnFingerprint,
  tableContentSchema,
  TABLE_LIMITS,
  TABLE_PAYLOAD_MAX_BYTES,
  TABLE_SCHEMA_VERSION,
  type TableCell,
  type TableColumn,
  type TableColumnType,
  type TableContent,
  type TableRow,
} from "@sourceweft/contracts/table";

/**
 * The largest table content a generation can store, for the size check of the
 * data table evaluation (`scripts/eval-table.ts --size`): Chinese text (three
 * UTF-8 bytes a character), every cell `found` at the cell limit with the
 * maximum evidence at the quote limit. Built only from the content contract.
 */

// Varied enough that no two cells are the same text.
const FILLER =
  "根据二〇二三年年度报告，公司全年营业收入为一百二十亿元，同比增长百分之十五；净利润率保持在百分之八左右。" +
  "报告期内研发投入占营业收入的比例为百分之十一，新增专利三百余项，主要产品在华东、华南市场的份额继续提升。" +
  "管理层表示，下一阶段将扩大海外销售网络，并在二〇二五年前完成第二条生产线的建设与验收工作。";

function chineseText(length: number, seed: number): string {
  const start = (seed * 37) % FILLER.length;
  let text = "";
  while (text.length < length + start) text += FILLER;
  return text.slice(start, start + length);
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

// The prompt version only feeds fingerprints here; the engine's own constant is
// not importable from the backend.
const PROMPT_VERSION = "table-v1";
const COLUMN_TYPES: TableColumnType[] = ["text", "number", "date", "boolean"];

export function buildWorstCaseTable(
  options: { sources?: number; columns?: number; language?: string } = {},
): TableContent {
  const sourceCount = options.sources ?? 50;
  const columnCount = options.columns ?? 8;
  const language = options.language ?? "zh-CN";

  const columns: TableColumn[] = Array.from({ length: columnCount }, (_, index) => {
    const spec = {
      name: chineseText(TABLE_LIMITS.columnNameChars, index),
      description: chineseText(TABLE_LIMITS.columnDescriptionChars, index + 100),
      type: COLUMN_TYPES[index % COLUMN_TYPES.length]!,
    };
    return { id: newTableColumnId(), ...spec, fingerprint: tableColumnFingerprint(spec) };
  });

  const rows: TableRow[] = Array.from({ length: sourceCount }, (_, rowIndex) => {
    const sourceId = randomUUID();
    const documentId = randomUUID();
    const contentHash = createHash("sha256").update(sourceId).digest("hex");
    const cells: Record<string, TableCell> = {};
    columns.forEach((column, columnIndex) => {
      const seed = rowIndex * columnCount + columnIndex;
      cells[column.id] = {
        status: "found",
        value: chineseText(TABLE_LIMITS.cellChars, seed),
        normalized: 12_000_000_000 + seed,
        evidence: Array.from({ length: TABLE_LIMITS.evidencePerCell }, (_, e) => {
          const quote = chineseText(TABLE_LIMITS.quoteChars, seed * 3 + e + 1);
          return {
            kind: "chunk" as const,
            sourceId,
            documentId,
            chunkId: randomUUID(),
            chunkNo: 100 + e,
            headingPath: null,
            quote,
            startChar: 1000,
            endChar: 1000 + quote.length,
            quoteHash: sha256(quote),
          };
        }),
        fingerprint: tableCellFingerprint({
          columnFingerprint: column.fingerprint,
          contentHash,
          promptVersion: PROMPT_VERSION,
          language,
        }),
      };
    });
    return {
      id: newTableRowId(),
      sourceId,
      documentId,
      title: chineseText(120, rowIndex + 7),
      contentHash,
      status: "ok",
      cells,
    };
  });

  const cellCount = sourceCount * columnCount;
  return {
    schemaVersion: TABLE_SCHEMA_VERSION,
    kind: "table",
    language,
    columns,
    rows,
    generation: {
      promptVersion: PROMPT_VERSION,
      modelAlias: "chat-default",
      stats: {
        sources: sourceCount,
        columns: columnCount,
        found: cellCount,
        notFound: 0,
        unverified: 0,
        reusedCells: 0,
        failedRows: 0,
        skippedRows: 0,
        modelCalls: sourceCount,
        tokensEstimated: 299_999,
      },
      recipe: {
        instruction: chineseText(TABLE_LIMITS.instructionChars, 3),
        columns: columns.map(({ id, name, description, type }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          type,
        })),
        sourceIds: rows.map((row) => row.sourceId),
      },
    },
  };
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The engine's fallback when content is too large: one evidence per cell. */
function withOneEvidence(content: TableContent): TableContent {
  return {
    ...content,
    rows: content.rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(
        Object.entries(row.cells).map(([id, cell]) => [
          id,
          cell.status === "found" ? { ...cell, evidence: cell.evidence.slice(0, 1) } : cell,
        ]),
      ),
    })),
  };
}

export type Timing = { median: number; min: number; max: number };

function time(iterations: number, run: () => void): Timing {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)]!,
    min: samples[0]!,
    max: samples[samples.length - 1]!,
  };
}

export type TableSizeMeasure = {
  bytes: number;
  bytesWithOneEvidence: number;
  limitBytes: number;
  overLimit: boolean;
  overLimitWithOneEvidence: boolean;
  /** JSON.stringify of the content. */
  serializeMs: Timing;
  /** JSON.parse of the serialized content. */
  parseMs: Timing;
  /** `tableContentSchema.parse` of the parsed content. */
  validateMs: Timing;
};

/** Serialized size against the payload limit, and how long reading it back takes. */
export function measureTableSize(
  content: TableContent,
  options: { iterations?: number } = {},
): TableSizeMeasure {
  const iterations = options.iterations ?? 20;
  const json = JSON.stringify(content);
  const parsed: unknown = JSON.parse(json);
  const bytes = byteLength(content);
  const bytesWithOneEvidence = byteLength(withOneEvidence(content));
  return {
    bytes,
    bytesWithOneEvidence,
    limitBytes: TABLE_PAYLOAD_MAX_BYTES,
    overLimit: bytes > TABLE_PAYLOAD_MAX_BYTES,
    overLimitWithOneEvidence: bytesWithOneEvidence > TABLE_PAYLOAD_MAX_BYTES,
    serializeMs: time(iterations, () => JSON.stringify(content)),
    parseMs: time(iterations, () => JSON.parse(json)),
    validateMs: time(iterations, () => tableContentSchema.parse(parsed)),
  };
}
