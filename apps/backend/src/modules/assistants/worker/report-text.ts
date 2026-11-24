/**
 * The text a worker's report becomes outside its own conversation: the
 * `worker_report` event the Router reads and the shared feed item. Pure, so
 * it is tested without a database.
 */
import { ASSISTANT_LIMITS } from "../limits";
import type { WorkerReportStatus } from "./tools";

/** The `worker_report` event's text: `status: summary`, plus the question. */
export function workerReportText(input: {
  status: WorkerReportStatus;
  summary: string;
  question?: string;
}): string {
  const base = `${input.status}: ${input.summary}`;
  return input.question ? `${base}\nQuestion: ${input.question}` : base;
}

/**
 * A worker cites its sources with `[citation:key]` markers, which only mean
 * something inside the ticket's own conversation. The report travels to the
 * shared feed, the ticket card and the Router, so the markers are removed
 * there; the cited answer stays in the conversation.
 */
export function stripCitationMarkers(text: string): string {
  const stripped = text
    .replace(/[ \t]*\[citation:[^\]\s]*\]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return stripped || text;
}

/** The feed item for a report: the summary, then the question on its own
 * paragraph. The status is the item's `ticketEvent`, shown as a label. */
export function workerReportFeedText(input: {
  summary: string;
  question?: string;
}): string {
  return capFeedText(
    input.question ? `${input.summary}\n\n${input.question}` : input.summary,
  );
}

function capFeedText(text: string): string {
  const max = ASSISTANT_LIMITS.feedMessageMax;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
