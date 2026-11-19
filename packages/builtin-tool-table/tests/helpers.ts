import {
  tableCellFingerprint,
  type TableCell,
  type TableColumn,
  type TableColumnInput,
  type TableContent,
  type TableRow,
} from "@sourceweft/contracts/table";
import type {
  FillTableInput,
  TableCheckpoint,
  TableFigurePort,
  TableModelPort,
  TableSourceInput,
} from "@sourceweft/contracts/table-capability";
import type {
  GroundedAnchorPort,
  GroundedCheckpointStore,
} from "@sourceweft/contracts/grounded-generation";
import { TABLE_PROMPT_VERSION } from "../src/engine/constants";
import { resolveColumns } from "../src/engine/plan";

export type ModelCall = Parameters<TableModelPort["completeStructured"]>[0];

/** A scripted model: `respond` decides each answer; every call is recorded. */
export function stubModel(respond: (call: ModelCall) => unknown | Promise<unknown>) {
  const calls: ModelCall[] = [];
  const model: TableModelPort = {
    async completeStructured(call) {
      calls.push(call);
      return respond(call);
    },
  };
  return { model, calls };
}

/** A source with one chunk per text; chunk ids are `<id>-c<n>`. */
export function sourceOf(
  id: string,
  texts: string[] = [`The ${id} source states its facts here.`],
  options: { indexed?: boolean; contentHash?: string; title?: string } = {},
): TableSourceInput {
  return {
    sourceId: id,
    documentId: `doc-${id}`,
    title: options.title ?? `Title of ${id}`,
    contentHash: options.contentHash ?? `hash-${id}`,
    indexed: options.indexed ?? true,
    chunks: texts.map((text, index) => ({
      chunkId: `${id}-c${index + 1}`,
      sourceId: id,
      documentId: `doc-${id}`,
      chunkNo: index,
      headingPath: null,
      language: "en",
      text,
    })),
  };
}

export function columnsOf(...inputs: TableColumnInput[]): TableColumn[] {
  return resolveColumns(inputs);
}

export const textColumn = (name: string, description?: string): TableColumnInput => ({
  name,
  ...(description ? { description } : {}),
  type: "text",
});
export const numberColumn = (name: string): TableColumnInput => ({ name, type: "number" });
export const dateColumn = (name: string): TableColumnInput => ({ name, type: "date" });
export const booleanColumn = (name: string): TableColumnInput => ({ name, type: "boolean" });

/**
 * A previous version whose every cell has the given status (default `found`),
 * with fingerprints that match the current prompt version, so the engine sees
 * them as reusable unless a test changes something.
 */
export function previousOf(input: {
  columns: TableColumn[];
  sources: TableSourceInput[];
  language?: string;
  status?: (source: TableSourceInput, column: TableColumn) => TableCell["status"];
  rowStatus?: (source: TableSourceInput) => TableRow["status"];
}): TableContent {
  const language = input.language ?? "en";
  const rows: TableRow[] = input.sources.map((source, index) => {
    const cells: Record<string, TableCell> = {};
    for (const column of input.columns) {
      const fingerprint = tableCellFingerprint({
        columnFingerprint: column.fingerprint,
        contentHash: source.contentHash,
        promptVersion: TABLE_PROMPT_VERSION,
        language,
      });
      const status = input.status?.(source, column) ?? "found";
      cells[column.id] =
        status === "found"
          ? {
              status,
              value: `old ${column.name} of ${source.sourceId}`,
              evidence: [
                {
                  kind: "chunk",
                  sourceId: source.sourceId,
                  documentId: source.documentId,
                  chunkId: source.chunks[0]?.chunkId ?? "none",
                  quote: "old quote",
                  quoteHash: `sha256:${"b".repeat(64)}`,
                },
              ],
              fingerprint,
            }
          : { status, fingerprint };
    }
    return {
      id: `r_${index.toString(16).padStart(32, "0")}`,
      sourceId: source.sourceId,
      documentId: source.documentId,
      title: source.title,
      contentHash: source.contentHash,
      status: input.rowStatus?.(source) ?? "ok",
      cells,
    };
  });
  return {
    schemaVersion: 1,
    kind: "table",
    language,
    columns: input.columns,
    rows,
    generation: {
      promptVersion: TABLE_PROMPT_VERSION,
      modelAlias: "test-model",
      stats: {
        sources: rows.length,
        columns: input.columns.length,
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
        columns: input.columns.map(({ id, name, description, type }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          type,
        })),
        sourceIds: input.sources.map((source) => source.sourceId),
      },
    },
  };
}

export function fillInput(
  columns: TableColumn[],
  sources: TableSourceInput[],
  overrides: Partial<FillTableInput> = {},
): FillTableInput {
  return {
    artifactId: "art_1",
    versionNo: 1,
    columns,
    sources,
    language: "en",
    modelAlias: "test-model",
    recipe: {
      columns: columns.map(({ id, name, description, type }) => ({
        id,
        name,
        ...(description ? { description } : {}),
        type,
      })),
      sourceIds: sources.map((source) => source.sourceId),
    },
    ...overrides,
  };
}

/**
 * Anchors each newline-separated part of the claim that the chunk contains
 * verbatim, standing in for the host's lexical/semantic anchoring.
 */
export function substringAnchor(): GroundedAnchorPort & { requests: number } {
  const port = {
    requests: 0,
    async anchor(
      requests: readonly { text: string; chunkContent: string }[],
    ) {
      port.requests += requests.length;
      return requests.map(({ text, chunkContent }) => {
        // The longest line of the claim that the chunk holds word for word.
        let best: { start: number; part: string } | null = null;
        for (const part of text.split("\n")) {
          const trimmed = part.trim();
          const start = trimmed ? chunkContent.indexOf(trimmed) : -1;
          if (start >= 0 && (!best || trimmed.length > best.part.length)) {
            best = { start, part: trimmed };
          }
        }
        return best
          ? {
              startChar: best.start,
              endChar: best.start + best.part.length,
              quote: best.part,
              confidence: 0.9,
            }
          : null;
      });
    },
  };
  return port;
}

const NUMBER = /(\d[\d,]*(?:\.\d+)?)\s*(k|万|亿)?/gi;

function figuresIn(text: string): number[] {
  const values: number[] = [];
  for (const match of text.normalize("NFKC").matchAll(NUMBER)) {
    const base = Number.parseFloat(match[1]!.replaceAll(",", ""));
    const unit = match[2]?.toLowerCase();
    values.push(
      base * (unit === "k" ? 1_000 : unit === "万" ? 10_000 : unit === "亿" ? 1e8 : 1),
    );
  }
  return values;
}

/** Every figure of the claim appears in the passage, `1,200` and `1.2k` alike. */
export const figures: TableFigurePort = {
  covered(claim, passage) {
    const available = figuresIn(passage);
    return figuresIn(claim).every((figure) =>
      available.some((value) => Math.abs(value - figure) < 1e-6),
    );
  },
};

export function memoryCheckpoint(): GroundedCheckpointStore<TableCheckpoint> & {
  value: TableCheckpoint | null;
  saves: number;
} {
  const store = {
    value: null as TableCheckpoint | null,
    saves: 0,
    async load() {
      return store.value ? structuredClone(store.value) : null;
    },
    async save(checkpoint: TableCheckpoint) {
      store.saves += 1;
      store.value = structuredClone(checkpoint);
    },
  };
  return store;
}

/** Handles of the chunks in a fill prompt, in order. */
export function promptHandles(user: string): string[] {
  return [...user.matchAll(/<<<CHUNK (c\d+)/g)].map((match) => match[1]!);
}

/** The column ids a fill prompt asks for, in order. */
export function promptColumnIds(user: string): string[] {
  return [...user.matchAll(/id="(col_[0-9a-f]{32})"/g)].map((match) => match[1]!);
}

/** Handles the engine gives the chunks of the sources it reads, in order. */
export function handlesOf(sources: readonly TableSourceInput[]): Map<string, string> {
  const handles = new Map<string, string>();
  let next = 1;
  for (const source of sources) {
    for (const chunk of source.chunks) handles.set(chunk.chunkId, `c${next++}`);
  }
  return handles;
}

export type AnswerCell = {
  columnId: string;
  found: boolean;
  value: string | null;
  chunk: string | null;
  quote: string | null;
};

export const answer = (
  columnId: string,
  value: string,
  chunk: string,
  quote: string,
): AnswerCell => ({ columnId, found: true, value, chunk, quote });

export const absent = (columnId: string): AnswerCell => ({
  columnId,
  found: false,
  value: null,
  chunk: null,
  quote: null,
});

/** The calls of a stub model that are fill (not merge) calls. */
export const isFill = (call: ModelCall) => call.operation === "table.fill";
export const isMerge = (call: ModelCall) => call.operation === "table.merge";

/** The handle of the chunk in a fill prompt whose text contains `needle`. */
export function handleHolding(user: string, needle: string): string | undefined {
  for (const block of user.split("<<<CHUNK ").slice(1)) {
    if (block.includes(needle)) return block.match(/^(c\d+)/)![1];
  }
  return undefined;
}

/**
 * The answer for one column: found, citing the chunk of this prompt that holds
 * `quote`, when the prompt has such a chunk; not found otherwise.
 */
export function answerIfStated(
  user: string,
  columnId: string,
  value: string,
  quote: string,
): AnswerCell {
  const handle = handleHolding(user, quote);
  return handle ? answer(columnId, value, handle, quote) : absent(columnId);
}
