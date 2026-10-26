import { isAccountSpecificGatewayHost } from "./account-gateways";
import { readCatalogEndpoint } from "./catalog-endpoint";
import { memberObservedTool, type MemberObservedTool } from "./member-observed-tool";
import { endpointKeyHash, pinEndpoint, sameEndpoint } from "./endpoint-pin";
import {
  MEMBER_OBSERVED_REVISIONS_PER_DAY,
  MEMBER_OBSERVED_SUBSET_WINDOW_MS,
  ToolRevisionInputError,
  canonicalizeTools,
  hashCanonicalTools,
  validateTools,
} from "./canonical";
import { recordToolRevision } from "./record";

/**
 * A member's authenticated tool discovery, kept for the public listing
 * (Issue #367). What is kept is what the server said about its own tools —
 * name, description and the structure of the input schema — and nothing about
 * the member: this module is not told who connected, nor which workspace.
 *
 * Callers must treat it as fire-and-forget: it throws on a database failure
 * and the member's connection must not depend on it.
 */

export type MemberObservationSkip =
  | "not-catalog"
  | "empty"
  | "incomplete"
  | "endpoint"
  | "gateway"
  | "taken-down"
  | "reduced"
  | "recent"
  | "busy"
  | "invalid";

export type MemberObservationResult =
  | { recorded: true; outcome: "created" | "confirmed" | "throttled" }
  | { recorded: false; reason: MemberObservationSkip };

/**
 * A burst of members on one listing must not pile transactions up on its
 * advisory lock: the same list recorded for a listing in the last
 * {@link RECENT_WINDOW_MS} is not offered again, and at most
 * {@link MAX_IN_FLIGHT} recordings run at once (the rest are dropped; the next
 * member's connection offers the list again).
 */
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const RECENT_MAX_ENTRIES = 1_000;
const MAX_IN_FLIGHT = 4;
const recent = new Map<string, number>();
let inFlight = 0;

function seenRecently(key: string, now: number): boolean {
  const at = recent.get(key);
  return at !== undefined && now - at < RECENT_WINDOW_MS;
}

function remember(key: string, now: number) {
  recent.delete(key);
  recent.set(key, now);
  for (const oldest of recent.keys()) {
    if (recent.size <= RECENT_MAX_ENTRIES) break;
    recent.delete(oldest);
  }
}

/** For tests: forget what was recorded recently. */
export function resetMemberObservationState() {
  recent.clear();
  inFlight = 0;
}

/**
 * Records the tools a member's own connection returned as the listing's
 * `member-observed` list, when ALL of these hold:
 *
 * - the install came from a public catalog listing (`marketIdentifier`);
 * - the endpoint the member connected to is that listing's CURRENT raw
 *   `manifest.endpointUrl` (same scheme, host, port, path and query), not an
 *   address the member or an install override edited it to;
 * - the endpoint is not an account-specific gateway;
 * - the discovery was complete and listed at least one tool;
 * - an admin has not taken this source down for the listing.
 *
 * Otherwise nothing is written and the reason says why.
 */
export async function recordMemberObservedTools(input: {
  marketIdentifier: string | null | undefined;
  /** The endpoint the discovery actually connected to. */
  endpointUrl: string | null | undefined;
  tools: readonly MemberObservedTool[];
  /** False when the list was cut off (too many tools, an oversize definition). */
  complete: boolean;
  observedAt?: Date;
}): Promise<MemberObservationResult> {
  if (!input.marketIdentifier || !input.endpointUrl) {
    return { recorded: false, reason: "not-catalog" };
  }
  const used = pinEndpoint(input.endpointUrl);
  if (!used) return { recorded: false, reason: "endpoint" };
  if (isAccountSpecificGatewayHost(used.hostname)) {
    return { recorded: false, reason: "gateway" };
  }
  if (!input.complete) return { recorded: false, reason: "incomplete" };
  if (input.tools.length === 0) return { recorded: false, reason: "empty" };

  const kept = [];
  for (const tool of input.tools) {
    const entry = memberObservedTool(tool);
    if (!entry) return { recorded: false, reason: "invalid" };
    kept.push(entry);
  }

  let hash: string;
  try {
    hash = hashCanonicalTools(canonicalizeTools(validateTools(kept)));
  } catch (error) {
    if (error instanceof ToolRevisionInputError) {
      return { recorded: false, reason: "invalid" };
    }
    throw error;
  }
  const key = `${input.marketIdentifier}\u0000${hash}`;
  const startedAt = (input.observedAt ?? new Date()).getTime();
  if (seenRecently(key, startedAt)) return { recorded: false, reason: "recent" };
  if (inFlight >= MAX_IN_FLIGHT) return { recorded: false, reason: "busy" };
  inFlight++;
  try {
    return await recordObserved(
      { marketIdentifier: input.marketIdentifier, endpointUrl: input.endpointUrl, observedAt: input.observedAt },
      kept,
      used,
      key,
      startedAt,
    );
  } finally {
    inFlight--;
  }
}

async function recordObserved(
  input: {
    marketIdentifier: string;
    endpointUrl: string;
    observedAt?: Date;
  },
  kept: NonNullable<ReturnType<typeof memberObservedTool>>[],
  used: NonNullable<ReturnType<typeof pinEndpoint>>,
  key: string,
  now: number,
): Promise<MemberObservationResult> {
  const entry = await readCatalogEndpoint(input.marketIdentifier);
  if (!entry) return { recorded: false, reason: "not-catalog" };
  if (!sameEndpoint(input.endpointUrl, entry.endpointUrl)) {
    return { recorded: false, reason: "endpoint" };
  }
  try {
    const result = await recordToolRevision({
      itemId: entry.itemId,
      source: "member-observed",
      tools: kept,
      endpointKey: endpointKeyHash(used),
      observedAt: input.observedAt,
      skipWhenTakenDown: true,
      maxRevisionsPerDay: MEMBER_OBSERVED_REVISIONS_PER_DAY,
      skipSubsetWithinMs: MEMBER_OBSERVED_SUBSET_WINDOW_MS,
    });
    if (result.outcome === "taken-down") return { recorded: false, reason: "taken-down" };
    if (result.outcome === "older") return { recorded: false, reason: "recent" };
    // Whatever was decided for this list stands for a while: asking again
    // would only repeat it.
    remember(key, now);
    if (result.outcome === "subset") return { recorded: false, reason: "reduced" };
    return { recorded: true, outcome: result.outcome };
  } catch (error) {
    if (error instanceof ToolRevisionInputError) {
      return { recorded: false, reason: "invalid" };
    }
    throw error;
  }
}
