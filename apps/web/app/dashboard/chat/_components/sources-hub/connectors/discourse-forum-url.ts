/**
 * The forum address rules the Discourse connector enforces server-side
 * (`parseForumUrl` in packages/builtin-connector-discourse), mirrored here so
 * a member gets an immediate answer. Only the shape is checked; the server
 * stays the authority and normalises the address.
 */

export const DISCOURSE_CONNECTOR_TYPE = "discourse";
export const DISCOURSE_FORUM_URL_MAX_LENGTH = 512;

const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** `https://` (lowercase), a host of letters, digits, dots and hyphens, and an
 * optional path of unreserved characters and slashes. Nothing else: no
 * userinfo, port, bracket, query, fragment, percent sign or non-ASCII. */
const SHAPE = /^https:\/\/([A-Za-z0-9.-]+)((?:\/[A-Za-z0-9._~-]*)*)$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_SUFFIXES = [".localhost", ".local", ".internal"];

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
export function isAcceptableForumUrl(value: string): boolean {
  if (value.length === 0 || value.length > DISCOURSE_FORUM_URL_MAX_LENGTH) {
    return false;
  }
  const match = SHAPE.exec(value);
  if (match === null) return false;
  return (
    isPublicHost((match[1] as string).toLowerCase()) &&
    isValidPath(match[2] as string)
  );
}
