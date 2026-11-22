import type { ResearchRun } from "@sourceweft/contracts/source-research";
import type { ResearchRunRow } from "./repository";

/**
 * The read pages behind a run, derived from the evidence ledger rather than
 * stored: each ledger entry is one source the user may confirm and import.
 */
export function researchSources(
  row: Pick<ResearchRunRow, "ledgerJson">,
): ResearchRun["sources"] {
  return row.ledgerJson.map((entry) => ({
    url: entry.url,
    title: entry.title,
    entryId: entry.id,
  }));
}

/**
 * Projects a stored run row onto the public `researchRunSchema` shape: the
 * source list comes from the ledger, timestamps become ISO strings, and the
 * nullable storage columns fall back to the schema's required defaults (a run
 * that has not started yet has no phase, so it reads as `planning`, and a run
 * with no citations reads as an empty list).
 */
export function toResearchRun(row: ResearchRunRow): ResearchRun {
  return {
    id: row.id,
    topic: row.topic,
    status: row.status,
    phase: row.phase ?? "planning",
    progress: row.progressJson,
    plan: row.planJson ?? null,
    report: row.reportMarkdown ?? null,
    citations: row.reportCitationsJson ?? [],
    sources: researchSources(row),
    errorCode: row.errorCode ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}
