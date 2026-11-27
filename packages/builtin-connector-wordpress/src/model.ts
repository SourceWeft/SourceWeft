import { createHash } from "node:crypto";
import type { ConnectorItem } from "@sourceweft/contracts";
import { WordPressError } from "./errors";
import { MAX_METADATA_TERMS } from "./limits";

/**
 * The typed shape of a WordPress site's REST answers and the parsers that turn
 * the untrusted documents into it. A parser is strict about what identifies an
 * object (its id, type, status, link and modified time) and tolerant about the
 * fields a site may legitimately leave out (a page has no categories or tags);
 * a document that does not fit throws a fixed-message `BAD_RESPONSE`, never a
 * partial object. Nothing in a document is treated as a URL except the post
 * `link`, which {@link validateLink} accepts only on the site's own host.
 */

export type WpContentType = "post" | "page";

export type WpListItem = {
  id: number;
  type: WpContentType;
  status: string;
  link: string;
  /** The decoded, single-line title. */
  title: string;
  /** `modified_gmt` as the site sent it (UTC, usually without a zone suffix). */
  modifiedGmt: string;
  categoryIds: number[];
  tagIds: number[];
  authorId: number | null;
};

export type WpPost = WpListItem & {
  /** HTML as the site rendered it. Untrusted. */
  contentHtml: string;
  /** `content.protected`: password protected, so `contentHtml` is empty. */
  protected: boolean;
  /** `date_gmt`, or `""` when the site sent none. */
  publishedGmt: string;
  slug: string;
};

export type WpTerm = { id: number; name: string; parent: number };
export type WpUser = { id: number; name: string };
export type WpMe = {
  id: number;
  name: string;
  capabilities: Record<string, boolean>;
};
export type WpSearchHit = {
  id: number;
  type: WpContentType;
  title: string;
  /** The `url` of a search result; untrusted, run it through {@link validateLink}. */
  url: string;
};

/** Category and tag names, by id, for the hash, the metadata and the Markdown. */
export type WpNames = {
  categories: Map<number, string>;
  tags: Map<number, string>;
};

// ------------------------------------------------------------------ text

const TITLE_MAX = 1_000;
const TERM_MAX = 200;
const AUTHOR_MAX = 200;
const SLUG_MAX = 200;
const LINK_MAX = 2_048;
/** Raw text longer than this is cut before any processing: a title is short. */
const RAW_TEXT_MAX = 20_000;
const FALLBACK_TITLE = "Untitled";

/** Truncates to `max` UTF-16 units without leaving half a surrogate pair. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** Collapses every run of whitespace and control characters, so a value can
 * never start a new line or block. */
export function oneLine(value: string): string {
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** A one-line, trimmed, length-capped string, or `null` when nothing is left. */
export function lineOf(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = oneLine(value);
  return flat === "" ? null : capText(flat, max);
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["ndash", "–"],
    ["mdash", "—"],
    ["lsquo", "‘"],
    ["rsquo", "’"],
    ["sbquo", "‚"],
    ["ldquo", "“"],
    ["rdquo", "”"],
    ["bdquo", "„"],
    ["dagger", "†"],
    ["bull", "•"],
    ["hellip", "…"],
    ["permil", "‰"],
    ["euro", "€"],
    ["trade", "™"],
    ["larr", "←"],
    ["rarr", "→"],
    ["hearts", "♥"],
  ]);
  // The Latin-1 block, U+00A0 to U+00FF, in the order HTML defines it.
  const latin1 =
    "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
      " ",
    );
  latin1.forEach((name, index) => {
    map.set(name, String.fromCharCode(0xa0 + index));
  });
  return map;
})();

function codePointText(codePoint: number): string {
  if (
    codePoint < 1 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "�";
  }
  return String.fromCodePoint(codePoint);
}

/** Removes `<tag>`-like runs in one left-to-right pass: a `<` that does not
 * start a tag, or a tag that is never closed, stays as written. */
function stripTags(text: string): string {
  const parts: string[] = [];
  let index = 0;
  for (;;) {
    const open = text.indexOf("<", index);
    if (open === -1) {
      parts.push(text.slice(index));
      break;
    }
    const next = text.charAt(open + 1);
    if (!/[A-Za-z/!?]/.test(next)) {
      parts.push(text.slice(index, open + 1));
      index = open + 1;
      continue;
    }
    const close = text.indexOf(">", open + 2);
    if (close === -1) {
      // No tag can close from here on, so the rest is plain text.
      parts.push(text.slice(index));
      break;
    }
    parts.push(text.slice(index, open));
    index = close + 1;
  }
  return parts.join("");
}

/** Decodes named and numeric entities once. An unknown name or a malformed
 * reference stays as written. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
      if (dec !== undefined) return codePointText(Number.parseInt(dec, 10));
      return NAMED_ENTITIES.get(name as string) ?? whole;
    },
  );
}

/**
 * A rendered REST text (a title or a term name) as plain text: markup removed,
 * entities decoded (after the markup is gone, so an encoded `&lt;b&gt;` stays
 * the text `<b>`), one line, at most `max` characters. Linear in its input.
 */
export function decodeText(rendered: string, max: number): string {
  const raw = capText(rendered, RAW_TEXT_MAX);
  return capText(oneLine(decodeEntities(stripTags(raw))), max);
}

/** The decoded, single-line title of a post or page. */
export function decodeTitle(rendered: string): string {
  return decodeText(rendered, TITLE_MAX);
}

// --------------------------------------------------------------- parsers

function bad(): WordPressError {
  return new WordPressError("BAD_RESPONSE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A term list: absent is empty (a page has none), anything else must be a
 * short list of positive integer ids. */
function idList(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) throw bad();
  const ids: number[] = [];
  for (const entry of value) {
    if (!isId(entry)) throw bad();
    ids.push(entry);
  }
  return ids;
}

const MODIFIED_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/;
const STATUS_FORMAT = /^[a-z][a-z0-9_-]{0,39}$/;

/** The instant of a WordPress GMT timestamp (`2026-01-02T03:04:05`, or with a
 * `Z`), or `null` when it is not a real date. */
function gmtDate(value: string): Date | null {
  if (!MODIFIED_FORMAT.test(value)) return null;
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderedOf(value: unknown): string {
  if (!isRecord(value) || typeof value.rendered !== "string") throw bad();
  return value.rendered;
}

/** One entry of a `posts` or `pages` listing. */
export function parseListItem(raw: unknown): WpListItem {
  if (!isRecord(raw) || !isId(raw.id)) throw bad();
  if (raw.type !== "post" && raw.type !== "page") throw bad();
  if (typeof raw.status !== "string" || !STATUS_FORMAT.test(raw.status)) {
    throw bad();
  }
  if (
    typeof raw.link !== "string" ||
    raw.link === "" ||
    raw.link.length > 8_192
  ) {
    throw bad();
  }
  if (
    typeof raw.modified_gmt !== "string" ||
    gmtDate(raw.modified_gmt) === null
  ) {
    throw bad();
  }
  const author = raw.author;
  if (author !== undefined && author !== null && !isCount(author)) throw bad();
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    link: raw.link,
    title: decodeTitle(renderedOf(raw.title)),
    modifiedGmt: raw.modified_gmt,
    categoryIds: idList(raw.categories),
    tagIds: idList(raw.tags),
    authorId: typeof author === "number" && author > 0 ? author : null,
  };
}

/** One post or page with its body. */
export function parsePost(raw: unknown): WpPost {
  const item = parseListItem(raw);
  const record = raw as Record<string, unknown>;
  const content = record.content;
  if (
    !isRecord(content) ||
    typeof content.rendered !== "string" ||
    typeof content.protected !== "boolean"
  ) {
    throw bad();
  }
  if (record.slug !== undefined && typeof record.slug !== "string") {
    throw bad();
  }
  return {
    ...item,
    contentHtml: content.rendered,
    protected: content.protected,
    publishedGmt:
      typeof record.date_gmt === "string"
        ? capText(oneLine(record.date_gmt), 64)
        : "",
    slug: capText(oneLine(record.slug ?? ""), SLUG_MAX),
  };
}

/** A category or a tag (a tag has no parent: 0). */
export function parseTerm(raw: unknown): WpTerm {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== "string") {
    throw bad();
  }
  if (raw.parent !== undefined && !isCount(raw.parent)) throw bad();
  return {
    id: raw.id,
    name: decodeText(raw.name, TERM_MAX),
    parent: raw.parent ?? 0,
  };
}

export function parseUser(raw: unknown): WpUser {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== "string") {
    throw bad();
  }
  return { id: raw.id, name: decodeText(raw.name, AUTHOR_MAX) };
}

/** `users/me?context=edit`: the signed-in user and the capabilities it holds. */
export function parseMe(raw: unknown): WpMe {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== "string") {
    throw bad();
  }
  const capabilities: Record<string, boolean> = {};
  if (raw.capabilities !== undefined) {
    const entries = isRecord(raw.capabilities)
      ? Object.entries(raw.capabilities)
      : null;
    if (entries === null || entries.length > 2_000) throw bad();
    for (const [name, value] of entries) {
      if (typeof value === "boolean") capabilities[name] = value;
    }
  }
  return {
    id: raw.id,
    name: decodeText(raw.name, AUTHOR_MAX),
    capabilities,
  };
}

/** One result of `search?type=post&subtype=post,page`. */
export function parseSearchHit(raw: unknown): WpSearchHit {
  if (
    !isRecord(raw) ||
    !isId(raw.id) ||
    typeof raw.title !== "string" ||
    typeof raw.url !== "string" ||
    (raw.subtype !== "post" && raw.subtype !== "page")
  ) {
    throw bad();
  }
  return {
    id: raw.id,
    type: raw.subtype,
    title: decodeTitle(raw.title),
    url: raw.url,
  };
}

// ----------------------------------------------------------------- links

/**
 * The citation URL of an item: `link` must be an https URL, without userinfo
 * or a port, on exactly the site host (case-insensitive). Anything else is
 * `LINK_HOST_MISMATCH`: a response never makes the connector point at, or
 * fetch, another host. Returns the parsed (normalised) URL.
 */
export function validateLink(link: string, siteHost: string): string {
  const mismatch = () => new WordPressError("LINK_HOST_MISMATCH");
  if (typeof link !== "string" || link === "" || link.length > LINK_MAX) {
    throw mismatch();
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw mismatch();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname !== siteHost.toLowerCase()
  ) {
    throw mismatch();
  }
  return url.href;
}

// ------------------------------------------------------------------ hash

/** The names of `ids` that are known, one line each, duplicates removed, in
 * the order of `ids`. The hash, the metadata and the Markdown share this list. */
export function termNames(ids: number[], names: Map<number, string>): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const name = lineOf(names.get(id), TERM_MAX);
    if (name !== null) out.push(name);
  }
  return out;
}

/**
 * Hex sha256 over `type | id | modified_gmt | link | title | status | sorted
 * category names | sorted tag names`, fields joined with U+0000 and the names
 * of one list with U+0001 (neither can occur in a one-line name). The author
 * and the body are not part of it: `modified_gmt` moves on any edit.
 */
export function contentHashOf(item: WpListItem, names: WpNames): string {
  const categories = termNames(item.categoryIds, names.categories).sort();
  const tags = termNames(item.tagIds, names.tags).sort();
  return createHash("sha256")
    .update(
      [
        item.type,
        String(item.id),
        item.modifiedGmt,
        item.link,
        item.title,
        item.status,
        categories.join("\u0001"),
        tags.join("\u0001"),
      ].join("\u0000"),
    )
    .digest("hex");
}

// ------------------------------------------------------------ item build

/** The display title: never empty. */
export function titleOf(item: WpListItem): string {
  return item.title === "" ? FALLBACK_TITLE : item.title;
}

/** `modified_gmt` or `date_gmt` as an ISO-8601 UTC string, or `null`. */
export function isoOf(gmt: string): string | null {
  return gmtDate(gmt)?.toISOString() ?? null;
}

function isFullPost(item: WpListItem | WpPost): item is WpPost {
  return "contentHtml" in item;
}

export function toConnectorItem(
  item: WpListItem | WpPost,
  names: WpNames,
  authorName: string | null,
  siteHost: string,
): ConnectorItem {
  const link = validateLink(item.link, siteHost);
  const modified = gmtDate(item.modifiedGmt);
  const metadata: Record<string, unknown> = {
    siteHost: siteHost.toLowerCase(),
    wpId: item.id,
    wpType: item.type,
  };
  if (isFullPost(item) && item.slug !== "") metadata.slug = item.slug;
  metadata.status = item.status;

  const categories: { id: number; name: string }[] = [];
  const seenCategories = new Set<number>();
  for (const id of item.categoryIds) {
    if (categories.length >= MAX_METADATA_TERMS) break;
    if (seenCategories.has(id)) continue;
    seenCategories.add(id);
    const name = lineOf(names.categories.get(id), TERM_MAX);
    if (name !== null) categories.push({ id, name });
  }
  if (categories.length > 0) metadata.categories = categories;
  const tags = termNames(item.tagIds, names.tags).slice(0, MAX_METADATA_TERMS);
  if (tags.length > 0) metadata.tags = tags;

  if (item.authorId !== null) metadata.authorId = item.authorId;
  const author = lineOf(authorName, AUTHOR_MAX);
  if (author !== null) metadata.authorName = author;
  if (isFullPost(item)) {
    const published = isoOf(item.publishedGmt);
    if (published !== null) metadata.publishedAt = published;
  }
  if (modified !== null) metadata.modifiedAt = modified.toISOString();

  return {
    externalId: `wordpress:${item.type}:${item.id}`,
    externalUri: link,
    title: titleOf(item),
    mimeType: "text/markdown",
    sizeBytes: null,
    externalUpdatedAt: modified,
    contentHash: contentHashOf(item, names),
    metadata,
  };
}
