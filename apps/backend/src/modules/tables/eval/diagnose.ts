import { matchesOutputLanguage } from "@sourceweft/grounded-generation";
import { extractFigures } from "../../citations/figures";
import type { EvalColumnType } from "./scoring";

/**
 * Why a data table evaluation run left cells `unverified` or rows `failed`,
 * reconstructed from what the evaluation script observed at the ports it
 * hands the engine (model answers, anchor requests and results, figure
 * checks) and the rows the engine produced (its content, or the checkpoint it
 * saved before a quality-gate failure). The engine itself is not changed or
 * imported: the few rules it applies between the ports (reading an answer,
 * reading one entry, the language check) are mirrored here and named as such.
 *
 * Checks the engine runs without a port (the date rule, the boolean rule, the
 * test whether a number value states any figure) are concluded by
 * elimination: every observable step passed and the cell still ended
 * `unverified`.
 */

/* ------------------------------------------------------- mirrored rules */

const CELL_CHARS = 300;
const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** Mirror of the engine's `RawCell` and `readFillAnswer` (engine/schemas.ts). */
export type RawCell = {
  columnId: string;
  found: boolean;
  value: string | null;
  chunk: string | null;
  quote: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown) =>
  typeof value === "string" ? value : null;

export function readFillAnswer(raw: unknown): RawCell[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.cells)) return null;
  const cells = new Map<string, RawCell>();
  for (const entry of raw.cells) {
    if (!isRecord(entry) || typeof entry.columnId !== "string") continue;
    if (typeof entry.found !== "boolean" || cells.has(entry.columnId)) continue;
    cells.set(entry.columnId, {
      columnId: entry.columnId,
      found: entry.found,
      value: stringOrNull(entry.value),
      chunk: stringOrNull(entry.chunk),
      quote: stringOrNull(entry.quote),
    });
  }
  return [...cells.values()];
}

/** Mirror of the engine's `answerMatchesLanguage` (engine/validate.ts). */
function answerMatchesLanguage(
  entries: readonly RawCell[],
  typeOf: ReadonlyMap<string, EvalColumnType>,
  language: string,
) {
  const text = entries
    .filter((entry) => entry.found && typeOf.get(entry.columnId) === "text")
    .map((entry) => entry.value ?? "")
    .join(" ");
  return matchesOutputLanguage(text, language);
}

/* ------------------------------------------------------------- inputs */

export type DiagnosisColumn = {
  id: string;
  engineId: string;
  type: EvalColumnType;
};
export type DiagnosisChunk = {
  handle: string;
  chunkId: string;
  sourceId: string;
  text: string;
};
export type DiagnosisCall = {
  operation: string;
  idempotencyKey: string;
  ok: boolean;
  error?: string;
  rawOutput?: unknown;
};
export type AnchorLogEntry = {
  requests: { text: string; chunkId: string }[];
  results?: ({ quote: string; confidence: number } | null)[];
  error?: string;
};
export type FigureLogEntry = {
  claim: string;
  passage: string;
  result: boolean;
};
export type DiagnosisRow = {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  /** By engine column id. */
  cells: Record<string, { status: "found" | "not_found" | "unverified" }>;
};

/* ------------------------------------------------------------ outputs */

export type CandidateOutcome =
  | "verified"
  | "empty_value"
  | "over_length"
  | "handle_of_another_source"
  | "unknown_handle"
  | "anchor_not_found"
  | "anchor_not_observed"
  | "no_figure_in_value"
  | "figure_check_failed"
  | "date_check_failed"
  | "boolean_unreadable";

export type CandidateDiagnosis = {
  group: number;
  /** As the model wrote them. */
  value: string | null;
  chunk: string | null;
  quote: string | null;
  outcome: CandidateOutcome;
  detail?: {
    handleSourceId?: string;
    /** Whether the model's quote / value appear verbatim in the claimed chunk. */
    quoteInChunk?: boolean;
    valueInChunk?: boolean;
    anchoredQuote?: string;
    anchorConfidence?: number;
    valueFigures?: number[];
    passageFigures?: number[];
  };
};

export type CellDiagnosis = {
  sourceId: string;
  column: string;
  type: EvalColumnType;
  reason: string;
  candidates: CandidateDiagnosis[];
  mergeOutput?: unknown;
};

export type RowDiagnosis = {
  sourceId: string;
  reason: string;
  calls: {
    idempotencyKey: string;
    operation: string;
    ok: boolean;
    error?: string;
  }[];
};

export type RunDiagnosis = {
  unverifiedCells: CellDiagnosis[];
  failedRows: RowDiagnosis[];
  /** Groups whose first answer failed the language check and were asked again. */
  languageRetries: { sourceId: string; group: number; retryPassed: boolean }[];
};

/* ---------------------------------------------------------- diagnosis */

type ParsedKey =
  | { kind: "fill"; sourceId: string; group: number; retry: boolean }
  | { kind: "merge"; sourceId: string; engineColumnId: string };

function parseKey(prefix: string, key: string): ParsedKey | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const merge = /^(.*):merge:(col_[0-9a-f]+)$/.exec(rest);
  if (merge)
    return { kind: "merge", sourceId: merge[1]!, engineColumnId: merge[2]! };
  const fill = /^(.*):g(\d+)(:retry)?$/.exec(rest);
  if (fill)
    return {
      kind: "fill",
      sourceId: fill[1]!,
      group: Number(fill[2]),
      retry: !!fill[3],
    };
  return null;
}

const describeCandidate: Record<CandidateOutcome, string> = {
  verified: "verified",
  empty_value: "empty value",
  over_length: `value longer than ${CELL_CHARS} characters`,
  handle_of_another_source: "cites a chunk of another source",
  unknown_handle: "cites no chunk of the corpus",
  anchor_not_found: "anchor port found no support in the cited chunk",
  anchor_not_observed: "no anchor request was observed",
  no_figure_in_value: "number value states no figure the engine reads",
  figure_check_failed: "figures of the value are not in the anchored passage",
  date_check_failed: "date rule failed against the anchored passage",
  boolean_unreadable: "value does not read as yes or no",
};

export function diagnoseRun(input: {
  artifactId: string;
  versionNo: number;
  language: string;
  columns: readonly DiagnosisColumn[];
  chunks: readonly DiagnosisChunk[];
  calls: readonly DiagnosisCall[];
  anchorLog: readonly AnchorLogEntry[];
  figureLog: readonly FigureLogEntry[];
  /** The rows the engine finished; a source with calls and no row failed. */
  rows: readonly DiagnosisRow[];
  quoteChars: number;
}): RunDiagnosis {
  const prefix = `table:${input.artifactId}:v${input.versionNo}:`;
  const chunkByHandle = new Map(
    input.chunks.map((chunk) => [chunk.handle, chunk]),
  );
  const handleByChunkId = new Map(
    input.chunks.map((chunk) => [chunk.chunkId, chunk.handle]),
  );
  const typeOfEngine = new Map(
    input.columns.map((column) => [column.engineId, column.type]),
  );
  const columnByEngine = new Map(
    input.columns.map((column) => [column.engineId, column]),
  );

  // Calls by source.
  const bySource = new Map<string, { call: DiagnosisCall; key: ParsedKey }[]>();
  for (const call of input.calls) {
    const key = parseKey(prefix, call.idempotencyKey);
    if (!key) continue;
    const list = bySource.get(key.sourceId) ?? [];
    list.push({ call, key });
    bySource.set(key.sourceId, list);
  }

  const anchorResults: {
    text: string;
    chunkId: string;
    result: { quote: string; confidence: number } | null;
  }[] = [];
  for (const entry of input.anchorLog) {
    entry.requests.forEach((request, index) => {
      if (entry.results)
        anchorResults.push({
          ...request,
          result: entry.results[index] ?? null,
        });
    });
  }

  const rowBySource = new Map(input.rows.map((row) => [row.sourceId, row]));
  const result: RunDiagnosis = {
    unverifiedCells: [],
    failedRows: [],
    languageRetries: [],
  };

  for (const [sourceId, calls] of bySource) {
    const fills = calls.filter((entry) => entry.key.kind === "fill") as {
      call: DiagnosisCall;
      key: Extract<ParsedKey, { kind: "fill" }>;
    }[];
    const groups = [...new Set(fills.map((entry) => entry.key.group))].sort(
      (a, b) => a - b,
    );

    // The answer the engine kept for each group, and what went wrong otherwise.
    const accepted = new Map<number, RawCell[]>();
    const rowProblems: string[] = [];
    for (const group of groups) {
      const first = fills.find(
        (entry) => entry.key.group === group && !entry.key.retry,
      );
      const retry = fills.find(
        (entry) => entry.key.group === group && entry.key.retry,
      );
      const attempts = [first, retry].filter((entry) => entry !== undefined);
      let kept: RawCell[] | null = null;
      for (const attempt of attempts) {
        if (!attempt.call.ok) {
          rowProblems.push(
            `fill call ${attempt.call.idempotencyKey} failed: ${attempt.call.error ?? "error"}`,
          );
          break;
        }
        const entries = readFillAnswer(attempt.call.rawOutput);
        if (!entries) {
          rowProblems.push(
            `fill call ${attempt.call.idempotencyKey}: the answer could not be read`,
          );
          break;
        }
        if (answerMatchesLanguage(entries, typeOfEngine, input.language)) {
          kept = entries;
          break;
        }
        if (attempt === retry || !retry) {
          rowProblems.push(
            `group ${group}: the answer was not in ${input.language}${retry ? " after one retry" : ""}`,
          );
        }
      }
      if (retry)
        result.languageRetries.push({
          sourceId,
          group,
          retryPassed: kept !== null && attempts.length === 2,
        });
      if (kept) accepted.set(group, kept);
    }

    const row = rowBySource.get(sourceId);
    if (!row || row.status === "failed") {
      for (const entry of calls) {
        if (entry.key.kind === "merge" && !entry.call.ok) {
          rowProblems.push(
            `merge call ${entry.call.idempotencyKey} failed: ${entry.call.error ?? "error"}`,
          );
        }
      }
      const ownChunkIds = new Set(
        input.chunks
          .filter((chunk) => chunk.sourceId === sourceId)
          .map((chunk) => chunk.chunkId),
      );
      for (const entry of input.anchorLog) {
        if (
          entry.error &&
          entry.requests.some((request) => ownChunkIds.has(request.chunkId))
        ) {
          rowProblems.push(`anchor port failed: ${entry.error}`);
        }
      }
      result.failedRows.push({
        sourceId,
        reason: rowProblems.join("; ") || "no failing call observed",
        calls: calls.map(({ call }) => ({
          idempotencyKey: call.idempotencyKey,
          operation: call.operation,
          ok: call.ok,
          ...(call.error ? { error: call.error } : {}),
        })),
      });
      continue;
    }

    for (const [engineId, cell] of Object.entries(row.cells)) {
      if (cell.status !== "unverified") continue;
      const column = columnByEngine.get(engineId);
      if (!column) continue;
      const candidates: CandidateDiagnosis[] = [];
      let answered = false;
      for (const [group, entries] of accepted) {
        const entry = entries.find(
          (candidate) => candidate.columnId === engineId,
        );
        if (!entry) continue;
        answered = true;
        if (!entry.found) continue;
        candidates.push(
          diagnoseCandidate({
            group,
            entry,
            sourceId,
            type: column.type,
            chunkByHandle,
            handleByChunkId,
            anchorResults,
            figureLog: input.figureLog,
            quoteChars: input.quoteChars,
          }),
        );
      }
      const merge = calls.find(
        (entry) =>
          entry.key.kind === "merge" && entry.key.engineColumnId === engineId,
      );
      let reason: string;
      if (!answered) reason = "the model left the column out of its answer";
      else if (merge)
        reason = "candidates disagreed and the merge call picked none";
      else if (candidates.length === 0)
        reason = "no claimed candidate (unexpected)";
      else
        reason = [
          ...new Set(candidates.map((c) => describeCandidate[c.outcome])),
        ].join("; ");
      result.unverifiedCells.push({
        sourceId,
        column: column.id,
        type: column.type,
        reason,
        candidates,
        ...(merge
          ? { mergeOutput: merge.call.rawOutput ?? merge.call.error ?? null }
          : {}),
      });
    }
  }
  return result;
}

function diagnoseCandidate(input: {
  group: number;
  entry: RawCell;
  sourceId: string;
  type: EvalColumnType;
  chunkByHandle: ReadonlyMap<string, DiagnosisChunk>;
  handleByChunkId: ReadonlyMap<string, string>;
  anchorResults: readonly {
    text: string;
    chunkId: string;
    result: { quote: string; confidence: number } | null;
  }[];
  figureLog: readonly FigureLogEntry[];
  quoteChars: number;
}): CandidateDiagnosis {
  const base = {
    group: input.group,
    value: input.entry.value,
    chunk: input.entry.chunk,
    quote: input.entry.quote,
  };
  const value = tidy(input.entry.value ?? "");
  const handle = input.entry.chunk?.trim() ?? "";
  if (value.length === 0) return { ...base, outcome: "empty_value" };
  if (value.length > CELL_CHARS) return { ...base, outcome: "over_length" };
  const chunk = input.chunkByHandle.get(handle);
  if (!chunk) return { ...base, outcome: "unknown_handle" };
  const quote = tidy(input.entry.quote ?? "");
  const verbatim = {
    quoteInChunk:
      quote.length > 0 && chunk.text.includes(input.entry.quote ?? ""),
    valueInChunk: chunk.text.includes(input.entry.value ?? ""),
  };
  if (chunk.sourceId !== input.sourceId) {
    return {
      ...base,
      outcome: "handle_of_another_source",
      detail: { handleSourceId: chunk.sourceId, ...verbatim },
    };
  }

  const anchorText = quote ? `${value}\n${quote}` : value;
  const anchored = input.anchorResults.find(
    (entry) => entry.chunkId === chunk.chunkId && entry.text === anchorText,
  );
  if (!anchored)
    return { ...base, outcome: "anchor_not_observed", detail: verbatim };
  if (!anchored.result || anchored.result.quote.trim().length === 0) {
    return { ...base, outcome: "anchor_not_found", detail: verbatim };
  }
  const anchoredQuote = [...anchored.result.quote]
    .slice(0, input.quoteChars)
    .join("");
  const detail = {
    ...verbatim,
    anchoredQuote,
    anchorConfidence: anchored.result.confidence,
  };

  switch (input.type) {
    case "text":
      return { ...base, outcome: "verified", detail };
    case "number": {
      const claim = value.normalize("NFKC");
      const passage = anchoredQuote.normalize("NFKC");
      const check = input.figureLog.find(
        (entry) => entry.claim === claim && entry.passage === passage,
      );
      const figures = {
        valueFigures: extractFigures(claim),
        passageFigures: extractFigures(passage, { months: true }),
      };
      if (!check)
        return {
          ...base,
          outcome: "no_figure_in_value",
          detail: { ...detail, ...figures },
        };
      return {
        ...base,
        outcome: check.result ? "verified" : "figure_check_failed",
        detail: { ...detail, ...figures },
      };
    }
    // Not observable at a port: the cell ended unverified with every
    // observable step passed, so the type rule is what failed.
    case "date":
      return { ...base, outcome: "date_check_failed", detail };
    case "boolean":
      return { ...base, outcome: "boolean_unreadable", detail };
  }
}
