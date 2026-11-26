import { createHash } from "node:crypto";
import type { ConnectorItem } from "@sourceweft/contracts";
import { noteHtmlToText } from "./note-text";

/** A Zotero collection with its parent resolved to a key (`null` = top level). */
export type ZoteroCollection = {
  key: string;
  version: number;
  name: string;
  parent: string | null;
};

export type CollectionTree = {
  /** The selected keys plus all their descendants. Unknown keys are ignored. */
  expand(selectedKeys: string[]): Set<string>;
  /** Names from the root joined by ` / `; `""` for an unknown key. */
  pathOf(key: string): string;
  /** Direct children of `parent` (`null` = top level), sorted by name. */
  children(parent: string | null): ZoteroCollection[];
};

/** One library object (item, note, attachment or annotation) as the API returns it. */
export type ZoteroObject = {
  key: string;
  version: number;
  itemType: string;
  parentItem: string | null;
  collections: string[];
  /** The raw `data` object, including Zotero's `deleted` flag when present. */
  data: Record<string, unknown>;
  webUrl: string | null;
};

export type ZoteroItemGroup = {
  item: ZoteroObject;
  notes: ZoteroObject[];
  attachments: Array<{
    attachment: ZoteroObject;
    annotations: ZoteroObject[];
  }>;
};

const TITLE_MAX = 1_000;
const FIELD_MAX = 2_000;
const LIST_MAX = 100;
const NOTE_TITLE_MAX = 200;
const ZOTERO_WEB_HOST = "www.zotero.org";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Truncates to `max` UTF-16 units without leaving half a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A trimmed, non-empty, length-capped string, or `null`. */
export function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : cap(trimmed, max);
}

function parseVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseCollection(raw: unknown): ZoteroCollection | null {
  if (!isRecord(raw)) return null;
  const { key, data } = raw;
  const version = parseVersion(raw.version);
  if (typeof key !== "string" || key === "" || version === null) return null;
  if (!isRecord(data)) return null;
  const { name, parentCollection } = data;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (parentCollection !== false && typeof parentCollection !== "string") {
    return null;
  }
  return {
    key,
    version,
    name,
    parent:
      parentCollection === false || parentCollection === ""
        ? null
        : parentCollection,
  };
}

export function buildCollectionTree(
  collections: ZoteroCollection[],
): CollectionTree {
  const byKey = new Map<string, ZoteroCollection>();
  const byParent = new Map<string | null, ZoteroCollection[]>();
  for (const collection of collections) {
    if (byKey.has(collection.key)) continue;
    byKey.set(collection.key, collection);
  }
  for (const collection of byKey.values()) {
    const siblings = byParent.get(collection.parent) ?? [];
    siblings.push(collection);
    byParent.set(collection.parent, siblings);
  }
  const byName = (a: ZoteroCollection, b: ZoteroCollection): number => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  for (const siblings of byParent.values()) siblings.sort(byName);

  return {
    expand(selectedKeys) {
      const result = new Set<string>();
      const queue = selectedKeys.filter((key) => byKey.has(key));
      while (queue.length > 0) {
        const key = queue.pop() as string;
        if (result.has(key)) continue;
        result.add(key);
        for (const child of byParent.get(key) ?? []) queue.push(child.key);
      }
      return result;
    },
    pathOf(key) {
      const names: string[] = [];
      const seen = new Set<string>();
      let current = byKey.get(key);
      while (current && !seen.has(current.key)) {
        seen.add(current.key);
        names.push(current.name);
        current =
          current.parent === null ? undefined : byKey.get(current.parent);
      }
      return names.reverse().join(" / ");
    },
    children(parent) {
      return [...(byParent.get(parent) ?? [])];
    },
  };
}

function safeWebUrl(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const links = raw.links;
  if (!isRecord(links) || !isRecord(links.alternate)) return null;
  const href = links.alternate.href;
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== ZOTERO_WEB_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

export function parseItem(raw: unknown): ZoteroObject | null {
  if (!isRecord(raw)) return null;
  const { key, data } = raw;
  const version = parseVersion(raw.version);
  if (typeof key !== "string" || key === "" || version === null) return null;
  if (!isRecord(data)) return null;
  if (typeof data.itemType !== "string" || data.itemType === "") return null;
  const parentItem =
    typeof data.parentItem === "string" && data.parentItem !== ""
      ? data.parentItem
      : null;
  const collections = Array.isArray(data.collections)
    ? data.collections.filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      )
    : [];
  return {
    key,
    version,
    itemType: data.itemType,
    parentItem,
    collections,
    data,
    webUrl: safeWebUrl(raw),
  };
}

function isTrashed(object: ZoteroObject): boolean {
  const flag = object.data.deleted;
  return flag !== undefined && flag !== null && flag !== false && flag !== 0;
}

/**
 * Groups library objects under their top-level item. Trashed objects are
 * dropped, so a scan and a later extract that sees trashed children
 * (`/items/KEY/children` includes them) still agree on the content hash. A
 * top-level `note` is a standalone group, a top-level `attachment` is dropped,
 * and a child whose parent is missing, trashed or of the wrong kind is dropped.
 */
export function groupLibrary(objects: ZoteroObject[]): {
  parents: ZoteroItemGroup[];
} {
  const live = new Map<string, ZoteroObject>();
  for (const object of objects) {
    if (isTrashed(object) || live.has(object.key)) continue;
    live.set(object.key, object);
  }

  const groups = new Map<string, ZoteroItemGroup>();
  for (const object of live.values()) {
    if (object.parentItem !== null) continue;
    if (object.itemType === "attachment" || object.itemType === "annotation") {
      continue;
    }
    groups.set(object.key, { item: object, notes: [], attachments: [] });
  }

  const attachmentSlots = new Map<
    string,
    { attachment: ZoteroObject; annotations: ZoteroObject[] }
  >();
  for (const object of live.values()) {
    if (object.itemType !== "attachment" || object.parentItem === null)
      continue;
    const group = groups.get(object.parentItem);
    if (!group || group.item.itemType === "note") continue;
    const slot = { attachment: object, annotations: [] };
    group.attachments.push(slot);
    attachmentSlots.set(object.key, slot);
  }
  for (const object of live.values()) {
    if (object.parentItem === null) continue;
    if (object.itemType === "note") {
      const group = groups.get(object.parentItem);
      if (group && group.item.itemType !== "note") group.notes.push(object);
    } else if (object.itemType === "annotation") {
      attachmentSlots.get(object.parentItem)?.annotations.push(object);
    }
  }

  return { parents: [...groups.values()] };
}

export function inScope(
  group: ZoteroItemGroup,
  expanded: Set<string> | null,
): boolean {
  if (expanded === null) return true;
  return group.item.collections.some((key) => expanded.has(key));
}

const versionEntry = (object: ZoteroObject): string =>
  `${object.key}:${object.version}`;

/**
 * Hex sha256 over the canonical form of: the parent `key:version`, the sorted
 * `key:version` of every note, attachment and annotation, and the sorted
 * collection paths. Order of children and paths does not matter.
 */
export function contentHashOf(
  group: ZoteroItemGroup,
  collectionPaths: string[],
): string {
  const children = [
    ...group.notes.map(versionEntry),
    ...group.attachments.flatMap(({ attachment, annotations }) => [
      versionEntry(attachment),
      ...annotations.map(versionEntry),
    ]),
  ].sort();
  const canonical = JSON.stringify([
    versionEntry(group.item),
    children,
    [...collectionPaths].sort(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function titleOf(item: ZoteroObject): string {
  const title = cleanString(item.data.title, TITLE_MAX);
  if (title !== null) return title;
  if (item.itemType === "note" && typeof item.data.note === "string") {
    for (const line of noteHtmlToText(item.data.note).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== "") return cap(trimmed, NOTE_TITLE_MAX);
    }
  }
  return "Untitled";
}

export function creatorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (names.length >= LIST_MAX) break;
    if (!isRecord(entry)) continue;
    const single = cleanString(entry.name, FIELD_MAX);
    if (single !== null) {
      names.push(single);
      continue;
    }
    const full = [entry.firstName, entry.lastName]
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter((part) => part !== "")
      .join(" ");
    if (full !== "") names.push(cap(full, FIELD_MAX));
  }
  return names;
}

export function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (tags.length >= LIST_MAX) break;
    if (!isRecord(entry)) continue;
    const tag = cleanString(entry.tag, FIELD_MAX);
    if (tag !== null) tags.push(tag);
  }
  return tags;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export function toConnectorItem(
  group: ZoteroItemGroup,
  libraryType: string,
  libraryId: string,
  collectionPaths: string[],
): ConnectorItem {
  const { item } = group;
  const metadata: Record<string, unknown> = {
    itemKey: item.key,
    version: item.version,
    itemType: item.itemType,
    libraryType,
    libraryId,
  };
  const creators = creatorNames(item.data.creators);
  if (creators.length > 0) metadata.creators = creators;
  const fields: Array<[string, unknown]> = [
    ["date", item.data.date],
    ["publicationTitle", item.data.publicationTitle],
    ["doi", item.data.DOI],
    ["isbn", item.data.ISBN],
    ["url", item.data.url],
  ];
  for (const [name, value] of fields) {
    const text = cleanString(value, FIELD_MAX);
    if (text !== null) metadata[name] = text;
  }
  const paths = collectionPaths
    .filter((path) => path !== "")
    .slice(0, LIST_MAX)
    .map((path) => cap(path, FIELD_MAX));
  if (paths.length > 0) metadata.collections = paths;
  const tags = tagNames(item.data.tags);
  if (tags.length > 0) metadata.tags = tags;

  return {
    externalId: `zotero:${item.key}`,
    externalUri: item.webUrl,
    title: titleOf(item),
    mimeType: "text/markdown",
    sizeBytes: null,
    externalUpdatedAt: parseDate(item.data.dateModified),
    contentHash: contentHashOf(group, collectionPaths),
    metadata,
  };
}
