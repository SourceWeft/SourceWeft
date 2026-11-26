import {
  ConnectorItemSkipError,
  type ConnectorExtractedText,
  type ConnectorItem,
} from "@sourceweft/contracts";
import type { ZoteroClient } from "./client";
import { ZoteroError } from "./errors";
import {
  contentHashOf,
  groupLibrary,
  parseItem,
  titleOf,
  type ZoteroObject,
} from "./model";
import { renderItemMarkdown } from "./render";

const ITEM_KEY = /^[A-Z0-9]{8}$/;

export type ExtractZoteroItemInput = {
  client: ZoteroClient;
  item: ConnectorItem;
};

function parseAll(raw: unknown[]): ZoteroObject[] {
  return raw.map((entry) => {
    const parsed = parseItem(entry);
    // The scan fails on an unreadable object too; guessing here would let the
    // extract hash drift from the scan hash.
    if (!parsed) throw new ZoteroError("ZOTERO_BAD_RESPONSE");
    return parsed;
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Re-reads one Zotero item (the item, its children, and the children of each
 * live attachment) and renders it as Markdown. The returned `contentHash` is
 * recomputed from what was just read with the same function the scan uses, so
 * an unchanged item hashes identically in both. An item deleted since the scan
 * is skipped; the next scan reconciles it away.
 */
export async function extractZoteroItem(
  input: ExtractZoteroItemInput,
): Promise<ConnectorExtractedText> {
  const { client, item } = input;
  const { itemKey, libraryType, libraryId } = item.metadata;
  // Checked before any URL is built. Corrupt metadata on one item skips that
  // item; it must not abort the whole run.
  if (typeof itemKey !== "string" || !ITEM_KEY.test(itemKey)) {
    throw new ConnectorItemSkipError("unreadable");
  }
  if (
    (libraryType !== "user" && libraryType !== "group") ||
    typeof libraryId !== "string"
  ) {
    throw new ConnectorItemSkipError("unreadable");
  }
  const collectionPaths = stringList(item.metadata.collections);

  let objects: ZoteroObject[];
  try {
    const { object } = await client.getObject(`items/${itemKey}`);
    const parent = parseItem(object);
    if (!parent || parent.key !== itemKey) {
      throw new ZoteroError("ZOTERO_BAD_RESPONSE");
    }
    const children = parseAll(
      await client.getList(`items/${itemKey}/children`),
    );
    objects = [parent, ...children];

    // Annotations hang off attachments; trashed ones are dropped by the same
    // grouping the scan uses, so their annotations are never requested.
    const first = groupLibrary(objects).parents[0];
    for (const { attachment } of first?.attachments ?? []) {
      if (!ITEM_KEY.test(attachment.key)) {
        throw new ZoteroError("ZOTERO_BAD_RESPONSE");
      }
      objects.push(
        ...parseAll(await client.getList(`items/${attachment.key}/children`)),
      );
    }
  } catch (error) {
    if (
      error instanceof ZoteroError &&
      (error.code === "ZOTERO_LIBRARY_NOT_FOUND" ||
        error.code === "ZOTERO_TOO_LARGE")
    ) {
      // Deleted since the scan, or too big to read in full. Attachments are
      // never capped: that would break equality with the scan's hash.
      throw new ConnectorItemSkipError("unreadable");
    }
    throw error;
  }

  const group = groupLibrary(objects).parents.find(
    (candidate) => candidate.item.key === itemKey,
  );
  // Trashed since the scan, or no longer a top-level item.
  if (!group) throw new ConnectorItemSkipError("unreadable");

  const markdown = renderItemMarkdown({
    group,
    collectionPaths,
    libraryType,
    libraryId,
  });
  return {
    item: {
      ...item,
      contentHash: contentHashOf(group, collectionPaths),
      title: titleOf(group.item),
    },
    contentText: markdown,
    markdown,
  };
}
