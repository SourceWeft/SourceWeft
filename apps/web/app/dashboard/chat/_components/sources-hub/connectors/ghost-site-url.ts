/**
 * Ghost facts the web needs for the add and rotate dialogs. These mirror the
 * rules the connector enforces server-side (`parseSiteUrl` and the stored
 * credential parser in packages/builtin-connector-ghost, which share the
 * WordPress site address rules) so a member gets an immediate answer; only the
 * shape is checked here and the server stays the authority.
 */

export const GHOST_CONNECTOR_TYPE = "ghost";
export const GHOST_SITE_URL_MAX_LENGTH = 512;
/** The Content API key the member copies from Ghost Admin is 26 hex
 * characters; the server accepts any printable ASCII up to this length. */
export const GHOST_API_KEY_MAX_LENGTH = 256;
/** The platform's credential form requires a non-empty username; Ghost has no
 * such thing, so every Ghost credential carries this fixed, non-secret one. */
export const GHOST_CREDENTIAL_USERNAME = "content-api";

const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** `https://` (lowercase), a host of letters, digits, dots and hyphens, and an
 * optional subfolder of unreserved characters and slashes. Nothing else: no
 * userinfo, port, bracket, query, fragment, percent sign or non-ASCII. */
const SHAPE = /^https:\/\/([A-Za-z0-9.-]+)((?:\/[A-Za-z0-9._~-]*)*)$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_SUFFIXES = [".localhost", ".local", ".internal"];
/** Printable ASCII with no whitespace. */
const API_KEY = /^[\x21-\x7e]+$/;

function isPublicHost(host: string): boolean {
  if (host.length > MAX_HOST_LENGTH || host === "localhost") return false;
  if (FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
    if (!LABEL.test(label)) return false;
  }
  // A TLD starts with a letter, which rules out dotted, decimal and hex IPs.
  return /^[a-z]/.test(labels[labels.length - 1] as string);
}

function isValidPath(path: string): boolean {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return true;
  return trimmed
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && !/^\.+$/.test(segment));
}

/** True for an `https://` address of a public DNS host with an optional
 * subfolder. The value must already be trimmed. */
export function isAcceptableGhostSiteUrl(value: string): boolean {
  if (value.length === 0 || value.length > GHOST_SITE_URL_MAX_LENGTH) {
    return false;
  }
  const match = SHAPE.exec(value);
  if (match === null) return false;
  return (
    isPublicHost((match[1] as string).toLowerCase()) &&
    isValidPath(match[2] as string)
  );
}

export function isAcceptableGhostApiKey(value: string): boolean {
  return value.length <= GHOST_API_KEY_MAX_LENGTH && API_KEY.test(value);
}
