import {
  newTableRowId,
  tableContentSchema,
  TABLE_LIMITS,
  TABLE_PAYLOAD_MAX_BYTES,
  TABLE_SCHEMA_VERSION,
  type TableCell,
  type TableColumn,
  type TableContent,
  type TableRow,
  type TableStats,
} from "@sourceweft/contracts/table";
import {
  GroundedGenerationError,
  isGroundedGenerationError,
} from "@sourceweft/contracts/grounded-generation";
import type {
  FillTableDeps,
  FillTableInput,
  TableCheckpoint,
  TableGenerationMembers,
  TableSourceInput,
} from "@sourceweft/contracts/table-capability";
import {
  anchorCandidates,
  assembleCorpus,
  groupCorpus,
  InputTooLargeError,
  MAX_TOTAL_INPUT_TOKENS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  type CorpusChunk,
  type CorpusGroup,
} from "@sourceweft/grounded-generation";
import {
  FILL_CONCURRENCY,
  fillMaxTokens,
  MAX_UNVERIFIED_SHARE,
  MERGE_MAX_OUTPUT_TOKENS,
  TABLE_PROMPT_VERSION,
} from "./constants";
import { resolveColumn, type ColumnOutcome, type VerifiedCandidate } from "./merge";
import { buildFillPrompt, buildMergePrompt } from "./prompts";
import {
  cellFingerprintFor,
  isReadable,
  planSourceCalls,
  type SourceCallPlan,
} from "./plan";
import {
  FILL_SCHEMA,
  MERGE_SCHEMA,
  readFillAnswer,
  readMergeChoice,
  type RawCell,
} from "./schemas";
import {
  answerMatchesLanguage,
  anchorTextOf,
  keptValue,
  readEntry,
} from "./validate";

/** Billing key of one fill call: one per source and group, bound to the version. */
export function fillIdempotencyKey(input: {
  artifactId: string;
  versionNo: number;
  sourceId: string;
  groupIndex: number;
  retry?: boolean;
}) {
  const key = `table:${input.artifactId}:v${input.versionNo}:${input.sourceId}:g${input.groupIndex}`;
  return input.retry ? `${key}:retry` : key;
}

export function mergeIdempotencyKey(input: {
  artifactId: string;
  versionNo: number;
  sourceId: string;
  columnId: string;
}) {
  return `table:${input.artifactId}:v${input.versionNo}:${input.sourceId}:merge:${input.columnId}`;
}

export function tableReferenceId(artifactId: string) {
  return `artifact:${artifactId}`;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Table generation was aborted");
  }
}

/** A source could not be filled; its row is `failed` and the rest go on. */
class RowFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RowFailure";
  }
}

/**
 * Runs a port call of one source. A typed grounded error (credits, model
 * unavailable) and an aborted job pass through and end the whole fill; any
 * other failure fails only this source's row.
 */
async function guarded<T>(
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isGroundedGenerationError(error) || signal?.aborted) throw error;
    throw new RowFailure(error instanceof Error ? error.message : "Port call failed", {
      cause: error,
    });
  }
}

/** Runs `worker` over `items`, `limit` at a time; the first error stops new work and is rethrown. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw failure;
}

type SourceResult =
  | { status: "ok"; cells: Record<string, TableCell> }
  | { status: "failed" };

type Counters = { modelCalls: number };

type Run = {
  deps: FillTableDeps;
  input: FillTableInput;
  columnById: ReadonlyMap<string, TableColumn>;
  counters: Counters;
};

function fingerprint(run: Run, column: TableColumn, source: TableSourceInput) {
  return cellFingerprintFor(column, source, run.input.language);
}

function toCell(
  run: Run,
  column: TableColumn,
  source: TableSourceInput,
  outcome: ColumnOutcome,
): TableCell {
  const base = { fingerprint: fingerprint(run, column, source) };
  if (outcome.status === "found") {
    return {
      status: "found",
      value: outcome.value,
      ...(outcome.normalized === undefined ? {} : { normalized: outcome.normalized }),
      evidence: outcome.evidence,
      ...base,
    };
  }
  return { status: outcome.status, ...base };
}

/** Asks the model about one group of one source; one retry when the language is wrong. */
async function askGroup(
  run: Run,
  source: TableSourceInput,
  group: CorpusGroup,
  columns: readonly TableColumn[],
): Promise<RawCell[]> {
  const prompt = buildFillPrompt({
    chunks: group.chunks,
    columns,
    language: run.input.language,
    ...(run.input.instruction ? { instruction: run.input.instruction } : {}),
  });
  for (const retry of [false, true]) {
    throwIfAborted(run.deps.signal);
    run.counters.modelCalls += 1;
    const raw = await guarded(run.deps.signal, () =>
      run.deps.model.completeStructured({
        operation: "table.fill",
        idempotencyKey: fillIdempotencyKey({
          artifactId: run.input.artifactId,
          versionNo: run.input.versionNo,
          sourceId: source.sourceId,
          groupIndex: group.index,
          retry,
        }),
        referenceId: tableReferenceId(run.input.artifactId),
        system: prompt.system,
        user: prompt.user,
        schema: FILL_SCHEMA,
        maxTokens: fillMaxTokens(columns.length),
      }),
    );
    const entries = readFillAnswer(raw);
    if (!entries) throw new RowFailure("The model's answer could not be read");
    if (answerMatchesLanguage(entries, run.columnById, run.input.language)) {
      return entries;
    }
  }
  throw new RowFailure("The model did not answer in the requested language");
}

/**
 * Fills the missing columns of one source: one call per group (retried once
 * for the wrong language), every claim anchored in the claimed chunk of this
 * source and held to its column's type rule, candidates from different groups
 * merged, and the result turned into cells.
 */
async function fillSource(
  run: Run,
  source: TableSourceInput,
  plan: SourceCallPlan,
  chunks: readonly CorpusChunk[],
): Promise<SourceResult> {
  const columns = plan.missingColumnIds.map((id) => run.columnById.get(id)!);
  const chunkByHandle = new Map(chunks.map((chunk) => [chunk.handle, chunk]));
  const ownHandles = new Set(chunkByHandle.keys());
  const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  const groups: CorpusGroup[] =
    tokens <= SINGLE_PASS_MAX_INPUT_TOKENS
      ? [{ index: 0, chunks: [...chunks], tokens }]
      : groupCorpus(chunks);

  type Candidate = {
    id: string;
    columnId: string;
    value: string;
    handle: string;
    quote: string | null;
  };
  const answered = new Set<string>();
  const claimed = new Set<string>();
  const candidates: Candidate[] = [];
  try {
    for (const group of groups) {
      const entries = await askGroup(run, source, group, columns);
      for (const entry of entries) {
        if (!run.columnById.has(entry.columnId)) continue;
        if (!plan.missingColumnIds.includes(entry.columnId)) continue;
        answered.add(entry.columnId);
        const read = readEntry(entry, ownHandles);
        if (read.kind === "absent") continue;
        claimed.add(entry.columnId);
        if (read.kind === "claim") {
          candidates.push({
            id: `${entry.columnId}#${group.index}`,
            columnId: entry.columnId,
            value: read.value,
            handle: read.handle,
            quote: read.quote,
          });
        }
      }
    }

    const evidence = await guarded(run.deps.signal, () =>
      anchorCandidates(
        candidates.map((candidate) => ({
          id: candidate.id,
          refs: [candidate.handle],
          text: anchorTextOf(candidate),
        })),
        run.deps.anchor,
        chunkByHandle,
        {
          evidencePerItem: TABLE_LIMITS.evidencePerCell,
          quoteChars: TABLE_LIMITS.quoteChars,
        },
      ),
    );

    const cells: Record<string, TableCell> = {};
    for (const column of columns) {
      const verified: VerifiedCandidate[] = [];
      for (const candidate of candidates) {
        if (candidate.columnId !== column.id) continue;
        // Evidence must come from this source, whatever the port returned.
        const own = (evidence.get(candidate.id) ?? []).filter(
          (entry) => entry.sourceId === source.sourceId,
        );
        if (own.length === 0) continue;
        // The value the type rule keeps, which for a date may be coarser than
        // the model wrote: it is what the cell stores, compares and sorts by.
        const value = keptValue(column, candidate.value, own, run.deps.figures);
        if (value === undefined) continue;
        verified.push({ value, evidence: own });
      }
      const outcome = await resolveColumn({
        type: column.type,
        // A column the model left out of every answer is not "not mentioned":
        // nothing was said, so nothing can be shown.
        claimed: claimed.has(column.id) || !answered.has(column.id),
        verified,
        choose: async (options) => {
          throwIfAborted(run.deps.signal);
          run.counters.modelCalls += 1;
          const prompt = buildMergePrompt({
            column,
            candidates: options.map((option) => ({
              value: option.value,
              quote: option.evidence[0]?.quote ?? null,
            })),
          });
          const raw = await guarded(run.deps.signal, () =>
            run.deps.model.completeStructured({
              operation: "table.merge",
              idempotencyKey: mergeIdempotencyKey({
                artifactId: run.input.artifactId,
                versionNo: run.input.versionNo,
                sourceId: source.sourceId,
                columnId: column.id,
              }),
              referenceId: tableReferenceId(run.input.artifactId),
              system: prompt.system,
              user: prompt.user,
              schema: MERGE_SCHEMA,
              maxTokens: MERGE_MAX_OUTPUT_TOKENS,
            }),
          );
          return readMergeChoice(raw);
        },
      });
      cells[column.id] = toCell(run, column, source, outcome);
    }
    return { status: "ok", cells };
  } catch (error) {
    if (error instanceof RowFailure) return { status: "failed" };
    throw error;
  }
}

function countCells(rows: readonly TableRow[]) {
  const counts = { found: 0, notFound: 0, unverified: 0 };
  for (const row of rows) {
    if (row.status !== "ok") continue;
    for (const cell of Object.values(row.cells)) {
      if (cell.status === "found") counts.found += 1;
      else if (cell.status === "not_found") counts.notFound += 1;
      else counts.unverified += 1;
    }
  }
  return counts;
}

/**
 * Of the cells the model answered in this run, too many that no source text
 * confirms means something systematic is wrong; nothing partial is returned.
 * Reused cells are not counted, so a broken new column cannot hide behind
 * columns that were already good.
 */
function assertQuality(rows: readonly TableRow[], plans: ReadonlyMap<string, SourceCallPlan>) {
  let found = 0;
  let unverified = 0;
  for (const row of rows) {
    if (row.status !== "ok") continue;
    for (const columnId of plans.get(row.sourceId)?.missingColumnIds ?? []) {
      const status = row.cells[columnId]?.status;
      if (status === "found") found += 1;
      else if (status === "unverified") unverified += 1;
    }
  }
  const claimed = found + unverified;
  if (claimed > 0 && unverified / claimed > MAX_UNVERIFIED_SHARE) {
    throw new GroundedGenerationError(
      "GENERATION_QUALITY_TOO_LOW",
      `${unverified} of ${claimed} extracted values could not be confirmed in their sources`,
      { found, unverified },
    );
  }
}

function capEvidence(rows: readonly TableRow[], cap: number): TableRow[] {
  return rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(
      Object.entries(row.cells).map(([id, cell]) => [
        id,
        cell.status === "found" ? { ...cell, evidence: cell.evidence.slice(0, cap) } : cell,
      ]),
    ),
  }));
}

const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Fills a table: one row per selected source, in selection order.
 *
 * Cells of the previous version that are still valid are copied as they are
 * (`planSourceCalls`). For every other source the model reads the text (one
 * call per group, `FILL_CONCURRENCY` sources at a time) and answers per column
 * with a value, the handle of the chunk that states it and a passage. A value
 * becomes a `found` cell only when the anchor port finds it in a chunk of that
 * very source and the column's type rule holds against the anchored text;
 * otherwise the cell is `unverified` and carries no value. Each finished row is
 * checkpointed, so a retried job does not read it again.
 */
export const fillTable: TableGenerationMembers["fillTable"] = async (deps, input) => {
  const progress = async (stage: "fill" | "finalize", done: number, total: number) => {
    await deps.onProgress?.({ stage, done, total });
  };
  throwIfAborted(deps.signal);

  const plans = planSourceCalls(input);
  const planBySource = new Map(plans.map((plan) => [plan.sourceId, plan]));
  if (!input.sources.some(isReadable)) {
    throw new GroundedGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources has indexed text",
    );
  }
  const totalTokens = plans.reduce((sum, plan) => sum + plan.tokens, 0);
  if (totalTokens > MAX_TOTAL_INPUT_TOKENS) {
    throw new GroundedGenerationError(
      "INPUT_TOO_LARGE",
      `The selected sources hold about ${totalTokens} tokens to read; at most ${MAX_TOTAL_INPUT_TOKENS} can be read at once`,
      { totalTokens },
    );
  }

  // One corpus for every source that has to be read, so a handle names exactly
  // one chunk of exactly one source.
  const needsCall = (source: TableSourceInput) =>
    planBySource.get(source.sourceId)!.missingColumnIds.length > 0;
  let corpusChunks: CorpusChunk[] = [];
  try {
    corpusChunks = assembleCorpus(
      input.sources.filter(needsCall).flatMap((source) => source.chunks),
      { maxTotalTokens: MAX_TOTAL_INPUT_TOKENS },
    ).chunks;
  } catch (error) {
    if (error instanceof InputTooLargeError) {
      throw new GroundedGenerationError("INPUT_TOO_LARGE", error.message, {
        totalTokens: error.totalTokens,
      });
    }
    throw error;
  }
  const chunksBySource = new Map<string, CorpusChunk[]>();
  for (const chunk of corpusChunks) {
    const list = chunksBySource.get(chunk.sourceId) ?? [];
    list.push(chunk);
    chunksBySource.set(chunk.sourceId, list);
  }

  const loaded = await deps.checkpoint?.load();
  const checkpoint: TableCheckpoint = {
    versionNo: input.versionNo,
    rows: loaded && loaded.versionNo === input.versionNo ? { ...loaded.rows } : {},
  };
  const previousRowIds = new Map(
    (input.previous?.rows ?? []).map((row) => [row.sourceId, row.id]),
  );
  const rowOf = (
    source: TableSourceInput,
    status: TableRow["status"],
    cells: Record<string, TableCell>,
  ): TableRow => ({
    id: previousRowIds.get(source.sourceId) ?? newTableRowId(),
    sourceId: source.sourceId,
    documentId: source.documentId,
    title: source.title,
    contentHash: source.contentHash,
    status,
    cells,
  });
  /** Reused cells and filled cells in column order. */
  const cellsInOrder = (plan: SourceCallPlan, filled: Record<string, TableCell>) =>
    Object.fromEntries(
      input.columns.flatMap((column) => {
        const cell = plan.reused[column.id] ?? filled[column.id];
        return cell ? [[column.id, cell] as const] : [];
      }),
    );

  const rows: (TableRow | undefined)[] = input.sources.map(() => undefined);
  const todo: { index: number; source: TableSourceInput }[] = [];
  input.sources.forEach((source, index) => {
    const plan = planBySource.get(source.sourceId)!;
    if (!isReadable(source)) {
      rows[index] = rowOf(source, "skipped", {});
    } else if (plan.missingColumnIds.length === 0) {
      rows[index] = rowOf(source, "ok", cellsInOrder(plan, {}));
    } else if (checkpoint.rows[source.sourceId]?.status === "ok") {
      rows[index] = checkpoint.rows[source.sourceId]!;
    } else {
      todo.push({ index, source });
    }
  });
  for (const sourceId of Object.keys(checkpoint.rows)) {
    if (!planBySource.has(sourceId)) delete checkpoint.rows[sourceId];
  }

  let done = input.sources.length - todo.length;
  await progress("fill", done, input.sources.length);

  const run: Run = {
    deps,
    input,
    columnById: new Map(input.columns.map((column) => [column.id, column])),
    counters: { modelCalls: 0 },
  };
  let saving: Promise<void> = Promise.resolve();
  const saveCheckpoint = () => {
    if (!deps.checkpoint) return Promise.resolve();
    const store = deps.checkpoint;
    saving = saving.then(() => store.save(structuredClone(checkpoint)));
    return saving;
  };

  await runPool(todo, FILL_CONCURRENCY, async ({ index, source }) => {
    throwIfAborted(deps.signal);
    const plan = planBySource.get(source.sourceId)!;
    const result = await fillSource(run, source, plan, chunksBySource.get(source.sourceId) ?? []);
    if (result.status === "failed") {
      // Not checkpointed: a retried job tries this source again.
      rows[index] = rowOf(source, "failed", {});
    } else {
      const row = rowOf(source, "ok", cellsInOrder(plan, result.cells));
      rows[index] = row;
      checkpoint.rows[source.sourceId] = row;
      await saveCheckpoint();
    }
    done += 1;
    await progress("fill", done, input.sources.length);
  });
  throwIfAborted(deps.signal);

  await progress("finalize", 0, 1);
  const finished = rows as TableRow[];
  assertQuality(finished, planBySource);

  const counts = countCells(finished);
  const stats: TableStats = {
    sources: finished.length,
    columns: input.columns.length,
    ...counts,
    reusedCells: finished.reduce(
      (sum, row) =>
        sum +
        (row.status === "ok"
          ? Object.keys(planBySource.get(row.sourceId)!.reused).length
          : 0),
      0,
    ),
    failedRows: finished.filter((row) => row.status === "failed").length,
    skippedRows: finished.filter((row) => row.status === "skipped").length,
    modelCalls: run.counters.modelCalls,
    tokensEstimated: totalTokens,
  };

  const assemble = (cap: number): TableContent =>
    tableContentSchema.parse({
      schemaVersion: TABLE_SCHEMA_VERSION,
      kind: "table",
      language: input.language,
      columns: input.columns,
      rows: capEvidence(finished, cap),
      generation: {
        promptVersion: TABLE_PROMPT_VERSION,
        modelAlias: input.modelAlias,
        stats,
        recipe: input.recipe,
      },
    });
  let content = assemble(TABLE_LIMITS.evidencePerCell);
  if (sizeOf(content) > TABLE_PAYLOAD_MAX_BYTES) {
    content = assemble(1);
    const bytes = sizeOf(content);
    if (bytes > TABLE_PAYLOAD_MAX_BYTES) {
      throw new GroundedGenerationError(
        "INPUT_TOO_LARGE",
        `The table is ${bytes} bytes even with one piece of evidence per cell; at most ${TABLE_PAYLOAD_MAX_BYTES} fit. Use fewer sources or columns.`,
        { bytes },
      );
    }
  }
  await progress("finalize", 1, 1);
  return { content, stats };
};
