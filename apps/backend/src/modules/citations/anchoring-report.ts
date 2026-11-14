import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { CITATION_ANCHORING_FEATURE } from "./anchoring-diagnostics";
import {
  SEMANTIC_MIN_MARGIN,
  SEMANTIC_MIN_SIMILARITY,
} from "./semantic-anchoring";

/**
 * Read-only report on how citation anchoring behaves on real conversations
 * (#516). It reads only the numbers and enums stored in
 * `citations.metadata_json.anchoring` and the existing LLM observability rows;
 * it never touches message or passage text and never writes.
 */
export const THRESHOLD_BAND = 0.05;

export type DecisionRow = {
  day: string;
  method: string;
  scripts: string;
  support: string;
  /** The by-meaning outcome, or null for a citation that never reached it. */
  outcome: string | null;
  count: number;
  /** By-meaning cases whose similarity is within the band of its threshold. */
  nearSimilarity: number;
  /** By-meaning cases whose margin is within the band of its threshold. */
  nearMargin: number;
};

export type EmbeddingStats = {
  calls: number;
  failed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type AnchoringReport = {
  since: Date;
  days: number;
  decisions: DecisionRow[];
  embedding: EmbeddingStats;
};

export async function loadAnchoringReport(input: {
  days: number;
  now?: Date;
}): Promise<AnchoringReport> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 86_400_000);
  const similarity = sql`(metadata_json->'anchoring'->'semantic'->>'similarity')::float8`;
  const margin = sql`(metadata_json->'anchoring'->'semantic'->>'margin')::float8`;

  const decisions = await db.execute<DecisionRow>(sql`
    select
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      metadata_json->'anchoring'->>'method' as method,
      metadata_json->'anchoring'->>'scripts' as scripts,
      coalesce(metadata_json->>'support', 'unknown') as support,
      metadata_json->'anchoring'->'semantic'->>'outcome' as outcome,
      count(*)::int as count,
      (count(*) filter (
        where abs(${similarity} - ${SEMANTIC_MIN_SIMILARITY}) <= ${THRESHOLD_BAND}
      ))::int as "nearSimilarity",
      (count(*) filter (
        where abs(${margin} - ${SEMANTIC_MIN_MARGIN}) <= ${THRESHOLD_BAND}
      ))::int as "nearMargin"
    from citations
    where created_at >= ${since}
      and metadata_json->'anchoring' is not null
    group by 1, 2, 3, 4, 5
    order by 1, 2, 3, 4, 5
  `);

  // The gateway sink records the embedding call as an llm_generations row
  // whose trace id is the scope id; it does not store the feature on it.
  const embedding = await db.execute<EmbeddingStats>(sql`
    select
      count(*)::int as calls,
      (count(*) filter (where status = 'error'))::int as failed,
      (percentile_cont(0.5) within group (order by latency_ms)
        filter (where status = 'ok'))::float8 as "p50Ms",
      (percentile_cont(0.95) within group (order by latency_ms)
        filter (where status = 'ok'))::float8 as "p95Ms",
      (percentile_cont(0.99) within group (order by latency_ms)
        filter (where status = 'ok'))::float8 as "p99Ms"
    from llm_generations
    where operation = 'embeddings.embedBatch'
      and trace_id like ${`%:${CITATION_ANCHORING_FEATURE}`}
      and started_at >= ${since}
      and status in ('ok', 'error')
  `);

  return {
    since,
    days: input.days,
    decisions: decisions.rows,
    embedding: embedding.rows[0] ?? {
      calls: 0,
      failed: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    },
  };
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${((part / whole) * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
  value === null ? "-" : `${Math.round(value)} ms`;

function tally<T>(
  rows: readonly T[],
  key: (row: T) => string,
  weight: (row: T) => number,
) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(key(row), (totals.get(key(row)) ?? 0) + weight(row));
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

function table(title: string, entries: Array<[string, number]>, total: number) {
  const lines = [title];
  if (entries.length === 0) lines.push("  (none)");
  for (const [name, count] of entries) {
    lines.push(
      `  ${name.padEnd(22)} ${String(count).padStart(7)}  ${percent(count, total).padStart(6)}`,
    );
  }
  return lines;
}

/** The report as plain text. Pure: the same rows always print the same way. */
export function formatAnchoringReport(report: AnchoringReport) {
  const rows = report.decisions;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const crossRows = rows.filter((row) => row.scripts !== "same");
  const cross = crossRows.reduce((sum, row) => sum + row.count, 0);
  const crossStrong = crossRows
    .filter((row) => row.support === "strong")
    .reduce((sum, row) => sum + row.count, 0);
  const semanticRows = rows.filter((row) => row.outcome !== null);
  const semanticTotal = semanticRows.reduce((sum, row) => sum + row.count, 0);

  const lines: string[] = [
    `Citation anchoring, last ${report.days} day(s) (since ${report.since.toISOString()})`,
    "",
    `Citations with a decision record: ${total}`,
    ...table(
      "By method",
      tally(
        rows,
        (r) => r.method,
        (r) => r.count,
      ),
      total,
    ),
    "",
    ...table(
      "By script pair",
      tally(
        rows,
        (r) => r.scripts,
        (r) => r.count,
      ),
      total,
    ),
    "",
    `Cross-language citations: ${cross}; judged strong: ${crossStrong} (${percent(crossStrong, cross)})`,
    ...table(
      "By-meaning outcome (cross-language citations that reached the second pass)",
      tally(
        semanticRows,
        (r) => r.outcome!,
        (r) => r.count,
      ),
      semanticTotal,
    ),
    "",
  ];

  const nearSimilarity = semanticRows.reduce((s, r) => s + r.nearSimilarity, 0);
  const nearMargin = semanticRows.reduce((s, r) => s + r.nearMargin, 0);
  lines.push(
    `Near a threshold (within +/-${THRESHOLD_BAND}), of ${semanticTotal} by-meaning decisions:`,
    `  similarity ${SEMANTIC_MIN_SIMILARITY}: ${nearSimilarity} (${percent(nearSimilarity, semanticTotal)})`,
    `  margin ${SEMANTIC_MIN_MARGIN}: ${nearMargin} (${percent(nearMargin, semanticTotal)})`,
    "",
  );

  const { embedding } = report;
  lines.push(
    "Embedding calls of the second pass (from llm_generations)",
    `  calls ${embedding.calls}, failed ${embedding.failed} (${percent(embedding.failed, embedding.calls)})`,
    `  latency p50 ${ms(embedding.p50Ms)}, p95 ${ms(embedding.p95Ms)}, p99 ${ms(embedding.p99Ms)}`,
    "",
    "Per day (cross-language citations, share judged strong)",
  );
  const days = [...new Set(rows.map((row) => row.day))].sort();
  if (days.length === 0) lines.push("  (none)");
  for (const day of days) {
    const dayRows = rows.filter(
      (row) => row.day === day && row.scripts !== "same",
    );
    const count = dayRows.reduce((sum, row) => sum + row.count, 0);
    const strong = dayRows
      .filter((row) => row.support === "strong")
      .reduce((sum, row) => sum + row.count, 0);
    const overBudget = dayRows
      .filter((row) => row.outcome === "over_budget")
      .reduce((sum, row) => sum + row.count, 0);
    lines.push(
      `  ${day}  cross ${String(count).padStart(5)}  strong ${percent(strong, count).padStart(6)}  over budget ${overBudget}`,
    );
  }
  if (cross < 500) {
    lines.push(
      "",
      `Note: ${cross} cross-language citations so far; recalibrating the thresholds needs at least 500 of them and 100 human labels.`,
    );
  }
  return lines.join("\n");
}
