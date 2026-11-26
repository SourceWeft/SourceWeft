import { WordPressError } from "./errors";

/** Longest accepted site address. */
const MAX_URL_LENGTH = 512;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Raw shape: `https://` (lower case), a host of letters, digits, dots and
 * hyphens, and an optional subfolder path of unreserved characters and
 * slashes. Nothing else can appear: no userinfo, port, bracket, query,
 * fragment, percent sign, backslash, space or non-ASCII character. This is the
 * same family as the config-schema pattern, but the schema admits `localhost`,
 * `127.0.0.1` and numeric hosts, which {@link validHost} rejects here.
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

/** Parses and normalises a site address without throwing; `null` if invalid. */
function tryParse(raw: unknown): { host: string; base: string } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > MAX_URL_LENGTH) return null;
  const match = SHAPE.exec(raw);
  if (match === null) return null;
  const host = (match[1] as string).toLowerCase();
  const path = match[2] as string;
  if (!validHost(host)) return null;
  if (!validPath(path)) return null;
  const subfolder = path.endsWith("/") ? path.slice(0, -1) : path;
  return { host, base: `https://${host}${subfolder}` };
}

/**
 * Validates a member-supplied site address and normalises it to a base:
 * https only, a lower-case public DNS host, an optional subfolder, no port,
 * userinfo, query or fragment, at most 512 characters, trailing slash trimmed.
 * Throws `WordPressError("SITE_URL_INVALID")` for anything else. The address is
 * parsed by hand, not by `URL`, so nothing is silently normalised away (dot
 * segments, percent-encoding, numeric hosts).
 */
export function parseSiteUrl(raw: string): string {
  const parsed = tryParse(raw);
  if (parsed === null) throw new WordPressError("SITE_URL_INVALID");
  return parsed.base;
}

/** The lower-case host of a base {@link parseSiteUrl} produced. */
export function siteHostOf(base: string): string {
  const parsed = tryParse(base);
  if (parsed === null) throw new WordPressError("SITE_URL_INVALID");
  return parsed.host;
}
