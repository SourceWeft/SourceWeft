import { isAccountSpecificGatewayHost } from "./account-gateways";
import { readCatalogEndpoint } from "./catalog-endpoint";
import { memberObservedTool, type MemberObservedTool } from "./member-observed-tool";
import { endpointKeyHash, pinEndpoint, sameEndpoint } from "./endpoint-pin";
import { ToolRevisionInputError } from "./canonical";
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
  | "invalid";

export type MemberObservationResult =
  | { recorded: true; outcome: "created" | "confirmed" | "throttled" }
  | { recorded: false; reason: MemberObservationSkip };

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
    });
    return result.outcome === "taken-down"
      ? { recorded: false, reason: "taken-down" }
      : { recorded: true, outcome: result.outcome };
  } catch (error) {
    if (error instanceof ToolRevisionInputError) {
      return { recorded: false, reason: "invalid" };
    }
    throw error;
  }
}
