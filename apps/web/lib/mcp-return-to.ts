import { LOCALE_IDS } from "@sourceweft/i18n/locales";

/**
 * Two small allowlists of internal paths for the MCP connection flow.
 * `acceptedMcpReturnTo` mirrors what the server accepts as the OAuth callback's
 * destination (the page the flow runs on). `acceptedMcpOrigin` is wider: where
 * a flow BEGAN (a chat thread, the public page), kept in this browser only so
 * "Use in chat" and "Close" can go back there. Neither trusts a query string
 * for more than choosing among these paths.
 */
const IDENTIFIER_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._~:@-]*";
const IDENTIFIER = new RegExp(
  `^${IDENTIFIER_SEGMENT}(?:/${IDENTIFIER_SEGMENT}){0,2}$`,
);
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOCALES: readonly string[] = LOCALE_IDS;

/** Backslash, query, fragment, whitespace and control characters. */
function hasForbiddenCharacter(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || "\\?#".includes(character)) return true;
  }
  return false;
}

function identifierSegment(encoded: string) {
  if (!/^[A-Za-z0-9._~:@%-]{1,300}$/.test(encoded)) return false;
  try {
    const decoded = decodeURIComponent(encoded);
    return !decoded.includes("%") && IDENTIFIER.test(decoded);
  } catch {
    return false;
  }
}

function pathShape(value: string | null | undefined) {
  if (!value || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (hasForbiddenCharacter(value)) return null;
  if (value.length > 1 && value.endsWith("/")) return null;
  return value;
}

/** The server's own allowlist: `/dashboard/mcp` and `/dashboard/mcp/<id>`. */
export function acceptedMcpReturnTo(value: string | null | undefined) {
  const path = pathShape(value);
  if (!path) return null;
  if (path === "/dashboard/mcp") return path;
  const segments = path.slice(1).split("/");
  return segments.length === 3 &&
    segments[0] === "dashboard" &&
    segments[1] === "mcp" &&
    identifierSegment(segments[2]!)
    ? path
    : null;
}

/** Where a flow may have begun: the market, a chat, or the public page. */
export function acceptedMcpOrigin(value: string | null | undefined) {
  const path = pathShape(value);
  if (!path) return null;
  if (acceptedMcpReturnTo(path)) return path;
  if (path === "/dashboard/chat") return path;
  const segments = path.slice(1).split("/");
  if (segments[0] === "dashboard" && segments.length === 3) {
    return segments[1] === "chat" && THREAD_ID.test(segments[2]!) ? path : null;
  }
  const rest = LOCALES.includes(segments[0]!) ? segments.slice(1) : segments;
  return rest.length === 2 && rest[0] === "mcp" && identifierSegment(rest[1]!)
    ? path
    : null;
}

/** The thread id when `returnTo` is one chat thread's page. */
export function chatThreadOf(returnTo: string | null) {
  const match = returnTo?.match(/^\/dashboard\/chat\/([A-Za-z0-9_-]+)$/);
  return match ? match[1]! : null;
}

const ORIGIN_KEY = "mcp:connection-origin";

/**
 * Remember where a connection flow began (a chat thread or the public page)
 * across the provider round trip. Browser storage is a convenience: without it
 * the flow simply has no origin.
 */
export function rememberMcpOrigin(returnTo: string | null) {
  try {
    if (returnTo) window.sessionStorage.setItem(ORIGIN_KEY, returnTo);
  } catch {
    /* storage unavailable */
  }
}

export function readMcpOrigin() {
  try {
    return acceptedMcpOrigin(window.sessionStorage.getItem(ORIGIN_KEY));
  } catch {
    return null;
  }
}

export function clearMcpOrigin() {
  try {
    window.sessionStorage.removeItem(ORIGIN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Once per page load: remember the origin the URL names, or forget a stale one.
 * A load that is the return from the provider (`mcpOAuth` is present) keeps
 * what was remembered before the hop.
 */
export function syncMcpOrigin(search: URLSearchParams) {
  const origin = acceptedMcpOrigin(search.get("returnTo"));
  if (origin) rememberMcpOrigin(origin);
  else if (!search.has("mcpOAuth")) clearMcpOrigin();
}
