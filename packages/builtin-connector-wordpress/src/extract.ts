import {
  ConnectorItemSkipError,
  type ConnectorExtractedContent,
} from "@sourceweft/contracts";
import type { WordPressClient } from "./client";
import { WordPressError } from "./errors";
import { fetchSingleItem, nameMap } from "./lookup";
import { toConnectorItem, type WpNames } from "./model";
import { renderContent } from "./render";

export type ExtractWordPressItemInput = {
  client: WordPressClient;
  /** `wordpress:post:<id>` or `wordpress:page:<id>`. */
  externalId: string;
  /** Login connector only: an item that is not published is still read. */
  includeUnpublished: boolean;
  /** The validated site host; the item's `link` must resolve to it. */
  siteHost: string;
  /** Cap on the Markdown length; defaults to the package limit. */
  maxChars?: number;
  signal?: AbortSignal;
};

const EXTERNAL_ID = /^wordpress:(post|page):([1-9][0-9]{0,9})$/;

/**
 * Re-reads one post or page and renders it as Markdown.
 *
 * The `contentHash` is computed with the function the scan uses over the same
 * inputs (the item's list fields and the site's current category and tag
 * names), so an unchanged item hashes identically in both and an item edited
 * since the scan returns the new hash. An item that is gone (404), password
 * protected, not published (without `includeUnpublished`), or that the site now
 * refuses with a rights error (R8b) is skipped as unreadable; the next scan
 * reconciles it. Every other failure, a site-wide login wall included, aborts
 * the run.
 */
export async function extractWordPressItem(
  input: ExtractWordPressItemInput,
): Promise<ConnectorExtractedContent> {
  const { client, includeUnpublished, siteHost, signal } = input;
  const match = EXTERNAL_ID.exec(
    typeof input.externalId === "string" ? input.externalId : "",
  );
  if (match === null) throw new WordPressError("CONFIG_INVALID");
  const type = match[1] as "post" | "page";
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) throw new WordPressError("CONFIG_INVALID");
  signal?.throwIfAborted();

  const post = await fetchSingleItem(
    client,
    type === "post" ? "posts" : "pages",
    id,
    includeUnpublished,
  );
  if (post === null || post.protected) {
    throw new ConnectorItemSkipError("unreadable");
  }

  signal?.throwIfAborted();
  const categoryNames = nameMap(await client.listCategories());
  signal?.throwIfAborted();
  const tagNames = nameMap(
    post.tagIds.length > 0 ? await client.listTags(post.tagIds) : [],
  );
  signal?.throwIfAborted();
  const authorNames =
    post.authorId !== null
      ? await client.listUsers([post.authorId])
      : new Map<number, string>();
  const authorName =
    post.authorId !== null ? (authorNames.get(post.authorId) ?? null) : null;

  const names: WpNames = { categories: categoryNames, tags: tagNames };
  const markdown = renderContent(
    post,
    names,
    authorName,
    siteHost,
    input.maxChars,
  );
  return {
    item: toConnectorItem(post, names, authorName, siteHost),
    contentText: markdown,
    markdown,
  };
}
