import { createHash } from "node:crypto";
import type { ConnectorItem } from "@sourceweft/contracts";
import { GhostError } from "./errors";
import { MAX_METADATA_TERMS } from "./limits";
import { validateCitationUrl } from "./site-url";

/**
 * The typed shape of a Ghost Content API answer and the parsers that turn the
 * untrusted documents into it. A parser is strict about what identifies an
 * object (its id, slug, url, update time and whether the key can read it in
 * full) and throws a fixed-message `BAD_RESPONSE` for anything that does not
 * fit, never a partial object. Text a member could mistake for structure (a
 * title, a tag or an author name) is collapsed to one line here. The `url` is
 * kept as the site sent it and checked by {@link toConnectorItem} and the
 * renderer, which are the only places it becomes a link.
 */

export type GhostContentType = "post" | "page";

export type GhostTag = { id: string; slug: string; name: string };

export type GhostListItem = {
  id: string;
  type: GhostContentType;
  slug: string;
  /** The site's own link for the item, as sent. Untrusted until validated. */
  url: string;
  /** One line, possibly empty. */
  title: string;
  /** `updated_at` as the site sent it. */
  updatedAt: string;
  publishedAt: string | null;
  visibility: string;
  /** False when the key cannot read the item in full (members-only or paid). */
  access: boolean;
  canonicalUrl: string | null;
  tags: GhostTag[];
};

export type GhostItem = GhostListItem & {
  /** HTML as the site rendered it; a teaser when `access` is false. Untrusted. */
  html: string;
  /** One-line author names. */
  authors: string[];
};

export type GhostPagination = { page: number; pages: number; total: number };

// ------------------------------------------------------------------ text

const TITLE_MAX = 1_000;
const NAME_MAX = 200;
const SLUG_MAX = 200;
const URL_MAX = 2_048;
const FALLBACK_TITLE = "Untitled";
/** Raw text longer than this is cut before any processing: a title is short. */
const RAW_TEXT_MAX = 20_000;
/** Tags and authors read from one item. */
const MAX_RELATIONS = 1_000;

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
  // Whitespace and control characters collapse to one space. Bidi overrides
  // and isolates are dropped so a title cannot visually reorder its own
  // metadata; zero-width joiners stay (emoji sequences need them).
  return value
    .replace(/[؜‎‏‪-‮⁦-⁩]/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
}

function lineOf(value: string, max: number): string {
  return capText(oneLine(capText(value, RAW_TEXT_MAX)), max);
}

// --------------------------------------------------------------- parsers

function bad(): GhostError {
  return new GhostError("BAD_RESPONSE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID_FORMAT = /^[0-9a-f]{24}$/;
const VISIBILITY_FORMAT = /^[a-z][a-z0-9_-]{0,39}$/;
const DATE_FORMAT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_FORMAT.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A timestamp exactly as the site sent it, which must be a real instant. */
function dateText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DATE_FORMAT.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw bad();
  }
  return value;
}

/** An absent or null date is `null`; a present one must be real. */
function optionalDate(value: unknown): string | null {
  return value === undefined || value === null ? null : dateText(value);
}

export function parseTag(raw: unknown): GhostTag {
  if (
    !isRecord(raw) ||
    !isId(raw.id) ||
    typeof raw.slug !== "string" ||
    typeof raw.name !== "string"
  ) {
    throw bad();
  }
  const slug = lineOf(raw.slug, SLUG_MAX);
  if (slug === "") throw bad();
  return { id: raw.id, slug, name: lineOf(raw.name, NAME_MAX) };
}

function parseTags(raw: unknown): GhostTag[] {
  if (!Array.isArray(raw) || raw.length > MAX_RELATIONS) throw bad();
  const seen = new Set<string>();
  const tags: GhostTag[] = [];
  for (const entry of raw) {
    const tag = parseTag(entry);
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    tags.push(tag);
  }
  return tags;
}

/** One entry of a `posts` or `pages` listing (with `include=tags`). */
export function parseListItem(
  raw: unknown,
  type: GhostContentType,
): GhostListItem {
  if (!isRecord(raw) || !isId(raw.id)) throw bad();
  if (typeof raw.slug !== "string" || typeof raw.url !== "string") throw bad();
  if (raw.url === "" || raw.url.length > 8_192) throw bad();
  if (typeof raw.title !== "string") throw bad();
  if (
    typeof raw.visibility !== "string" ||
    !VISIBILITY_FORMAT.test(raw.visibility)
  ) {
    throw bad();
  }
  if (typeof raw.access !== "boolean") throw bad();
  const canonical = raw.canonical_url;
  if (
    canonical !== undefined &&
    canonical !== null &&
    typeof canonical !== "string"
  ) {
    throw bad();
  }
  const slug = lineOf(raw.slug, SLUG_MAX);
  if (slug === "") throw bad();
  const canonicalUrl =
    typeof canonical === "string" ? lineOf(canonical, URL_MAX) : "";
  return {
    id: raw.id,
    type,
    slug,
    url: raw.url,
    title: lineOf(raw.title, TITLE_MAX),
    updatedAt: dateText(raw.updated_at),
    publishedAt: optionalDate(raw.published_at),
    visibility: raw.visibility,
    access: raw.access,
    canonicalUrl: canonicalUrl === "" ? null : canonicalUrl,
    tags: parseTags(raw.tags),
  };
}

/** One post or page read singly (`formats=html&include=tags,authors`). */
export function parseItem(raw: unknown, type: GhostContentType): GhostItem {
  const item = parseListItem(raw, type);
  const record = raw as Record<string, unknown>;
  if (typeof record.html !== "string") throw bad();
  const authors = record.authors;
  if (!Array.isArray(authors) || authors.length > MAX_RELATIONS) throw bad();
  const names: string[] = [];
  for (const author of authors) {
    if (!isRecord(author) || typeof author.name !== "string") throw bad();
    const name = lineOf(author.name, NAME_MAX);
    if (name !== "") names.push(name);
  }
  return { ...item, html: record.html, authors: names };
}

/** `meta.pagination` of a list answer. */
export function parsePagination(body: unknown): GhostPagination {
  if (!isRecord(body) || !isRecord(body.meta)) throw bad();
  const pagination = body.meta.pagination;
  if (!isRecord(pagination)) throw bad();
  const { page, pages, total } = pagination;
  if (!isCount(page) || page < 1 || !isCount(pages) || !isCount(total)) {
    throw bad();
  }
  return { page, pages, total };
}

// ------------------------------------------------------------------ hash

/**
 * Hex sha256 over `type | id | updated_at | url | title | visibility | sorted
 * tag slug:name pairs`, fields joined with U+0000 and the pairs with U+0001
 * (neither can occur in a one-line value). `updated_at` moves on any edit; a
 * tag rename changes the hash. The author names and the body are not part of
 * it, so a listing and a single read of one item hash alike.
 */
export function contentHashOf(item: GhostListItem | GhostItem): string {
  const tags = item.tags.map((tag) => `${tag.slug}:${tag.name}`).sort();
  return createHash("sha256")
    .update(
      [
        item.type,
        item.id,
        item.updatedAt,
        item.url,
        item.title,
        item.visibility,
        tags.join("\u0001"),
      ].join("\u0000"),
    )
    .digest("hex");
}

// ------------------------------------------------------------ item build

/** The display title: never empty. */
export function titleOf(item: GhostListItem): string {
  return item.title === "" ? FALLBACK_TITLE : item.title;
}

/** An instant the parser already accepted, as ISO-8601 UTC. */
export function isoOf(value: string): string {
  return new Date(value).toISOString();
}

function isFull(item: GhostListItem | GhostItem): item is GhostItem {
  return "html" in item;
}

/**
 * The scan's description of one item. `externalUri` is the post's own `url`,
 * validated as a citation link (`LINK_INVALID` otherwise); it may be on a host
 * other than the API host.
 */
export function toConnectorItem(
  item: GhostListItem | GhostItem,
  siteHost: string,
): ConnectorItem {
  const url = validateCitationUrl(item.url);
  const metadata: Record<string, unknown> = {
    siteHost: siteHost.toLowerCase(),
    ghostId: item.id,
    ghostType: item.type,
    slug: item.slug,
    visibility: item.visibility,
  };
  const tags = item.tags
    .slice(0, MAX_METADATA_TERMS)
    .map((tag) => ({ slug: tag.slug, name: tag.name }));
  if (tags.length > 0) metadata.tags = tags;
  if (isFull(item) && item.authors.length > 0) {
    metadata.authors = item.authors.slice(0, MAX_METADATA_TERMS);
  }
  if (item.publishedAt !== null) {
    metadata.publishedAt = isoOf(item.publishedAt);
  }
  metadata.updatedAt = isoOf(item.updatedAt);
  if (item.canonicalUrl !== null) metadata.canonicalUrl = item.canonicalUrl;

  return {
    externalId: `ghost:${item.type}:${item.id}`,
    externalUri: url,
    title: titleOf(item),
    mimeType: "text/markdown",
    sizeBytes: null,
    externalUpdatedAt: new Date(item.updatedAt),
    contentHash: contentHashOf(item),
    metadata,
  };
}
