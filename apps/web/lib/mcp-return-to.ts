/**
 * The internal routes an MCP connection flow may start from and return to. The
 * server accepts exactly these (and checks again); this mirror lets the page
 * decide where "Use in chat" and "Close" go without trusting a query string.
 */
const IDENTIFIER_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._~:@-]*";
const IDENTIFIER = new RegExp(
  `^${IDENTIFIER_SEGMENT}(?:/${IDENTIFIER_SEGMENT}){0,2}$`,
);
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOCALES = ["en", "zh-CN", "zh-TW"];

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

export function acceptedMcpReturnTo(value: string | null | undefined) {
  if (!value || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (hasForbiddenCharacter(value)) return null;
  if (value === "/dashboard/mcp" || value === "/dashboard/chat") return value;
  const segments = value.slice(1).split("/");
  if (segments[0] === "dashboard" && segments.length === 3) {
    if (segments[1] === "mcp" && identifierSegment(segments[2]!)) return value;
    if (segments[1] === "chat" && THREAD_ID.test(segments[2]!)) return value;
    return null;
  }
  const rest = LOCALES.includes(segments[0]!) ? segments.slice(1) : segments;
  return rest.length === 2 && rest[0] === "mcp" && identifierSegment(rest[1]!)
    ? value
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
    return acceptedMcpReturnTo(window.sessionStorage.getItem(ORIGIN_KEY));
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
