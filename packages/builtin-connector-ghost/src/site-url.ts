import { GhostError } from "./errors";

/** Longest accepted site address. */
const MAX_URL_LENGTH = 512;
/** Longest accepted citation link. */
const MAX_CITATION_LENGTH = 2_048;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Raw shape: `https://` (lower case), a host of letters, digits, dots and
 * hyphens, and an optional subfolder path of unreserved characters and
 * slashes. Nothing else can appear: no userinfo, port, bracket, query,
 * fragment, percent sign, backslash, space or non-ASCII character. This is the
 * same family as the config-schema pattern, but the schema admits `localhost`,
 * `127.0.0.1`, numeric hosts and `.`/`..` or empty path segments, which
 * {@link validHost} and {@link validPath} reject here.
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
 * Throws `GhostError("SITE_URL_INVALID")` for anything else. The address is
 * parsed by hand, not by `URL`, so nothing is silently normalised away (dot
 * segments, percent-encoding, numeric hosts).
 */
export function parseSiteUrl(raw: string): string {
  const parsed = tryParse(raw);
  if (parsed === null) throw new GhostError("SITE_URL_INVALID");
  return parsed.base;
}

/** The lower-case host of a base {@link parseSiteUrl} produced. */
export function siteHostOf(base: string): string {
  const parsed = tryParse(base);
  if (parsed === null) throw new GhostError("SITE_URL_INVALID");
  return parsed.host;
}

/** Anything that `URL` would silently drop or that cannot be in a link: a
 * control character, a space, a DEL or C1 character, or a backslash. */
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) {
      return true;
    }
  }
  return false;
}

/**
 * Validates the `url` a site reports for a post, which becomes the citation
 * link. https only, a public DNS-style host (it may differ from the API host),
 * no userinfo and no port; the path, query and fragment are free. Returns the
 * link unchanged and throws `GhostError("LINK_INVALID")` for anything else. The
 * value is a response field, so it is checked by hand before `URL` sees it.
 */
export function validateCitationUrl(url: string): string {
  const invalid = () => new GhostError("LINK_INVALID");
  if (typeof url !== "string") throw invalid();
  if (url.length === 0 || url.length > MAX_CITATION_LENGTH) throw invalid();
  if (hasUnsafeCharacter(url)) throw invalid();
  const match = /^https:\/\/([^/?#]*)(.*)$/.exec(url);
  if (match === null) throw invalid();
  const authority = match[1] as string;
  // Letters, digits, dots and hyphens only: no userinfo (`@`), port (`:`),
  // bracketed IPv6 literal or non-ASCII character.
  if (!/^[A-Za-z0-9.-]+$/.test(authority)) throw invalid();
  const host = authority.toLowerCase();
  if (!validHost(host)) throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    throw invalid();
  }
  return url;
}
