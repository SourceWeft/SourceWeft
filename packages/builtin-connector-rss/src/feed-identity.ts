import { createHash } from "node:crypto";
import type { ParsedFeedItem } from "./feed-parse";

/** Identities longer than this are replaced by a hash. */
const MAX_EXTERNAL_ID_LENGTH = 256;

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * `https`/`http` URL without its fragment and without `utm_*` tracking
 * parameters, or null when `link` is not such a URL. Stable across the
 * tracking noise a publisher appends per delivery.
 */
export function canonicalLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "") return null;
  url.hash = "";
  const tracking = [...url.searchParams.keys()].filter((key) =>
    key.toLowerCase().startsWith("utm_"),
  );
  for (const key of tracking) url.searchParams.delete(key);
  return url.toString();
}

const bounded = (id: string): string =>
  id.length > MAX_EXTERNAL_ID_LENGTH ? `h:${sha256Hex(id)}` : id;

/**
 * Stable per-item identity: the trimmed `guid`/`atom:id`, else the canonical
 * link, else a hash of title and ISO date. Anything over 256 characters is
 * hashed rather than truncated, so two long ids never collide on a prefix.
 */
export function itemIdentity(input: {
  guid: string | null;
  link: string | null;
  title: string;
  date: Date | null;
}): string {
  const guid = input.guid?.trim() ?? "";
  if (guid !== "") return bounded(guid);
  const link = input.link === null ? null : canonicalLink(input.link);
  if (link !== null) return bounded(link);
  const date = input.date === null ? "" : input.date.toISOString();
  return `h:${sha256Hex(`${input.title}|${date}`)}`;
}

/**
 * sha256 hex of the fields that make up an item's indexed content: title,
 * link (canonicalized, so rotating `utm_*` params or fragments do not
 * change it), author, date (published, else updated) and text. Dates enter as ISO
 * instants, so re-formatting a date does not change the hash. Fields are
 * JSON-encoded, so shifting text between two fields does.
 */
export function contentHashOf(
  item: Omit<ParsedFeedItem, "externalId">,
): string {
  const date = item.publishedAt ?? item.updatedAt;
  return sha256Hex(
    JSON.stringify([
      item.title,
      item.link === null ? null : (canonicalLink(item.link) ?? item.link),
      item.author,
      date === null ? null : date.toISOString(),
      item.text,
    ]),
  );
}
