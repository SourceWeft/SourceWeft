import {
  ConnectorItemSkipError,
  type ConnectorExtractedContent,
} from "@sourceweft/contracts";
import type { GhostClient, GhostItemRoute } from "./client";
import { GhostError } from "./errors";
import { toConnectorItem } from "./model";
import { renderContent } from "./render";

export type ExtractGhostItemInput = {
  client: GhostClient;
  /** `ghost:post:<id>` or `ghost:page:<id>`, the id being 24 lower-case hex. */
  externalId: string;
  /** The validated site host, as given to the scan. */
  siteHost: string;
  /** Cap on the Markdown length; defaults to the package limit. */
  maxChars?: number;
  signal?: AbortSignal;
};

const EXTERNAL_ID = /^ghost:(post|page):([0-9a-f]{24})$/;

/**
 * Re-reads one post or page and renders it as Markdown.
 *
 * The `contentHash` comes from the same function the scan uses, over the same
 * fields (the single read carries the item's tags too), so an unchanged item
 * hashes identically in both and an item edited since the scan returns the new
 * hash. An item that is gone (404) or that the key cannot read in full
 * (`access` false, a members-only or paid item that carries only a teaser) is
 * skipped as unreadable; the next scan reconciles it. Every other failure
 * aborts the run.
 */
export async function extractGhostItem(
  input: ExtractGhostItemInput,
): Promise<ConnectorExtractedContent> {
  const { client, siteHost, signal } = input;
  const match = EXTERNAL_ID.exec(
    typeof input.externalId === "string" ? input.externalId : "",
  );
  if (match === null) throw new GhostError("CONFIG_INVALID");
  const route: GhostItemRoute = match[1] === "page" ? "pages" : "posts";
  signal?.throwIfAborted();

  const item = await client.getItem(route, match[2] as string);
  if (item === null || !item.access) {
    throw new ConnectorItemSkipError("unreadable");
  }
  signal?.throwIfAborted();

  const markdown = renderContent(item, siteHost, input.maxChars);
  return {
    item: toConnectorItem(item, siteHost),
    contentText: markdown,
    markdown,
  };
}
