import { DiscourseError } from "./errors";

/** Longest accepted forum address. */
const MAX_URL_LENGTH = 512;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Raw shape: `https://` (lowercase), a host of letters, digits, dots and
 * hyphens, and an optional path of unreserved characters and slashes. Nothing
 * else can appear: no userinfo, port, bracket, query, fragment, percent
 * sign, backslash, space or non-ASCII character.
 */
const SHAPE = /^https:\/\/([A-Za-z0-9.-]+)((?:\/[A-Za-z0-9._~-]*)*)$/;

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_SUFFIXES = [".localhost", ".local", ".internal"];

function validHost(host: string): boolean {
  if (host.length > MAX_HOST_LENGTH) return false;
  if (host === "localhost") return false;
  if (FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  const labels = host.split(".");
  // A public name has a registrable domain and a TLD.
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
    if (!LABEL.test(label)) return false;
  }
  // A TLD starts with a letter (or `xn--`): this rejects dotted IPv4, decimal
  // (`2130706433`), hex (`0x7f000001`) and octal-looking numeric hosts, which
  // some resolvers read as addresses.
  return /^[a-z]/.test(labels[labels.length - 1] as string);
}

function validPath(path: string): boolean {
  // `path` is "" or starts with "/". One trailing slash is allowed (and
  // trimmed by the caller); every remaining segment must be a real name.
  if (path === "") return true;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return true;
  for (const segment of trimmed.slice(1).split("/")) {
    if (segment === "") return false;
    if (/^\.+$/.test(segment)) return false;
  }
  return true;
}

/**
 * Validates a user-supplied forum address and normalises it: https only, a
 * lowercase public DNS host, an optional subfolder path, no port, userinfo,
 * query or fragment, at most 512 characters. Returns null for anything else.
 * The address is parsed by hand, not by `URL`, so nothing is silently
 * normalised away (dot segments, percent-encoding, numeric hosts).
 */
export function parseForumUrl(
  raw: unknown,
): { origin: string; base: string } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > MAX_URL_LENGTH) return null;
  const match = SHAPE.exec(raw);
  if (match === null) return null;
  const host = (match[1] as string).toLowerCase();
  const path = match[2] as string;
  if (!validHost(host)) return null;
  if (!validPath(path)) return null;
  const origin = `https://${host}`;
  const subfolder = path.endsWith("/") ? path.slice(0, -1) : path;
  return { origin, base: `${origin}${subfolder}` };
}

/** A base must be exactly what {@link parseForumUrl} returned. */
function requireBase(base: string): string {
  const parsed = parseForumUrl(base);
  if (parsed === null || parsed.base !== base) {
    throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
  }
  return parsed.base;
}

function requireId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DiscourseError("DISCOURSE_CONFIG_INVALID");
  }
  return value;
}

/**
 * Discourse slugs are lowercase ASCII words joined by hyphens (or `topic`).
 * Anything else, hostile or merely unexpected, is replaced rather than
 * partially cleaned, so no fragment of it reaches a link.
 */
export function safeSlug(slug: unknown): string {
  if (typeof slug !== "string") return "topic";
  const lower = slug.toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(lower)) return "topic";
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed === "" ? "topic" : trimmed;
}

/** `<base>/t/<slug>/<topicId>`, built only from validated pieces. */
export function topicUrl(base: string, slug: string, topicId: number): string {
  return `${requireBase(base)}/t/${safeSlug(slug)}/${requireId(topicId)}`;
}

/** `<base>/t/<slug>/<topicId>/<postNumber>`, built only from validated pieces. */
export function postUrl(
  base: string,
  slug: string,
  topicId: number,
  postNumber: number,
): string {
  return `${topicUrl(base, slug, topicId)}/${requireId(postNumber)}`;
}
