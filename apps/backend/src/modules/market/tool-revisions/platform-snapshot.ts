import { and, desc, eq } from "drizzle-orm";
import { db, marketMcpToolRevisions } from "@sourceweft/db";
import {
  MARKET_MCP_SNAPSHOT_LIMITS,
  type MarketMcpToolSourceActionRequest,
  type SubmitMarketMcpPlatformSnapshotRequest,
  type SubmitMarketMcpPlatformSnapshotResponse,
} from "@sourceweft/market-contracts";
import { McpClaimError } from "../claims/errors";
import { ToolRevisionInputError } from "./canonical";
import { readCatalogEndpoint } from "./catalog-endpoint";
import {
  endpointKeyHash,
  pinEndpoint,
  pinOrigin,
} from "./endpoint-pin";
import { recordToolRevision, restoreToolSource, takedownToolSource } from "./record";

/**
 * The platform's own reference snapshot of a listing's tools (Issue #367): a
 * market admin's private tool reads a server with a reference account on its
 * own machine and submits the list. The server never fetches anything; what it
 * checks is that the list claims to come from the listing's CURRENT endpoint,
 * so a tool pinned to one address cannot attach its list to another, or to a
 * listing whose address has since changed.
 */

function refuse(status: number, code: string, message: string): never {
  throw new McpClaimError(status, code, message);
}

export async function submitPlatformSnapshot(
  input: SubmitMarketMcpPlatformSnapshotRequest,
  now: Date = new Date(),
): Promise<SubmitMarketMcpPlatformSnapshotResponse> {
  const claimedUrl = pinEndpoint(input.endpointUrl);
  const claimedOrigin = pinOrigin(input.endpointOrigin);
  if (!claimedUrl || !claimedOrigin) {
    refuse(
      422,
      "MCP_SNAPSHOT_ENDPOINT_INVALID",
      "endpointOrigin must be a bare http(s) origin and endpointUrl an http(s) URL, neither with credentials",
    );
  }
  if (claimedOrigin !== claimedUrl.origin) {
    refuse(
      422,
      "MCP_SNAPSHOT_ORIGIN_MISMATCH",
      "endpointOrigin is not the origin of endpointUrl",
    );
  }
  const observedAt = new Date(input.observedAt);
  if (observedAt.getTime() > now.getTime() + MARKET_MCP_SNAPSHOT_LIMITS.clockSkewMs) {
    refuse(422, "MCP_SNAPSHOT_FROM_THE_FUTURE", "observedAt is in the future");
  }

  const entry = await readCatalogEndpoint(input.identifier);
  if (!entry) refuse(404, "MCP_ITEM_NOT_FOUND", "MCP item not found");
  const current = entry.endpointUrl ? pinEndpoint(entry.endpointUrl) : null;
  if (!current) {
    refuse(
      409,
      "MCP_SNAPSHOT_NO_ENDPOINT",
      "This listing has no remote endpoint to take a snapshot of",
    );
  }
  if (current.key !== claimedUrl.key) {
    refuse(
      409,
      "MCP_SNAPSHOT_ENDPOINT_CHANGED",
      "endpointUrl is not the listing's current endpoint; re-read the listing and reinspect",
    );
  }

  // An older read must not become the current one: a slow run arriving after a
  // newer one would be recorded as a change back.
  const [latest] = await db
    .select({ lastConfirmedAt: marketMcpToolRevisions.lastConfirmedAt })
    .from(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, entry.itemId),
        eq(marketMcpToolRevisions.source, "platform-indexed"),
      ),
    )
    .orderBy(desc(marketMcpToolRevisions.revision))
    .limit(1);
  if (latest && observedAt.getTime() < latest.lastConfirmedAt.getTime()) {
    refuse(
      409,
      "MCP_SNAPSHOT_OLDER_THAN_LATEST",
      "A newer snapshot of this listing was already recorded",
    );
  }

  let result;
  try {
    result = await recordToolRevision({
      itemId: entry.itemId,
      source: "platform-indexed",
      tools: input.tools,
      observedAt,
      endpointKey: endpointKeyHash(current),
      referenceProfile: input.referenceProfile,
      skipWhenTakenDown: true,
    });
  } catch (error) {
    if (error instanceof ToolRevisionInputError) {
      refuse(422, `MCP_${error.code}`, error.message);
    }
    throw error;
  }
  if (result.outcome === "taken-down") {
    refuse(
      409,
      "MCP_SNAPSHOT_SOURCE_TAKEN_DOWN",
      "Platform snapshots of this listing were taken down by an admin; restore them first",
    );
  }
  return {
    identifier: entry.identifier,
    outcome: result.outcome,
    revision: result.revision,
    toolsHash: result.toolsHash,
    toolsCount: input.tools.length,
  };
}

/** An admin takes a source's tools down, or lets them be recorded again. */
export async function applyToolSourceAction(
  input: MarketMcpToolSourceActionRequest,
): Promise<{ identifier: string; source: string; action: string; changed: boolean }> {
  const entry = await readCatalogEndpoint(input.identifier);
  if (!entry) refuse(404, "MCP_ITEM_NOT_FOUND", "MCP item not found");
  let changed = true;
  if (input.action === "takedown") {
    await takedownToolSource({ itemId: entry.itemId, source: input.source });
  } else {
    changed = await restoreToolSource({ itemId: entry.itemId, source: input.source });
  }
  return { identifier: entry.identifier, source: input.source, action: input.action, changed };
}
