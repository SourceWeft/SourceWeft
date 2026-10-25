/**
 * Where the OAuth callback sends the browser once the attempt is over. The
 * callback URL itself stays the registered `/v1/mcp/oauth/callback`; this is an
 * INTERNAL destination, stored with the pending attempt and never taken from
 * the callback request. Only paths of the routes below are accepted — no
 * query, fragment, host or scheme — and the redirect is built from the
 * configured web base URL, so no input can name another origin.
 */
export const DEFAULT_MCP_RETURN_TO = "/dashboard/mcp";

const MAX_RETURN_TO_LENGTH = 512;
/** One percent-encoded market identifier: `owner/name` may arrive as `%2F`. */
const ENCODED_IDENTIFIER = /^[A-Za-z0-9._~:@%-]{1,300}$/;
const IDENTIFIER_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._~:@-]*";
const IDENTIFIER = new RegExp(
  `^${IDENTIFIER_SEGMENT}(?:/${IDENTIFIER_SEGMENT}){0,2}$`,
);

/** Backslash, query, fragment, whitespace and control characters. */
function hasForbiddenCharacter(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || "\\?#".includes(character)) return true;
  }
  return false;
}

function validIdentifierSegment(encoded: string) {
  if (!ENCODED_IDENTIFIER.test(encoded)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return false;
  }
  // One level of decoding only: a `%` left over is a double-encoded bypass.
  return !decoded.includes("%") && IDENTIFIER.test(decoded);
}

/**
 * The normalized internal path for `value`, or null if it is not one of the
 * application routes the connection flow starts from: `/dashboard/mcp` and
 * `/dashboard/mcp/<identifier>`.
 */
export function parseMcpReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null;
  // A single leading slash; no `//`, no backslash (browsers treat `\` as `/`),
  // no query, fragment, whitespace or control characters.
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (hasForbiddenCharacter(value)) return null;
  if (value.length > 1 && value.endsWith("/")) return null;

  if (value === "/dashboard/mcp") return value;

  const segments = value.slice(1).split("/");
  return segments.length === 3 &&
    segments[0] === "dashboard" &&
    segments[1] === "mcp" &&
    validIdentifierSegment(segments[2]!)
    ? value
    : null;
}

/**
 * The absolute redirect URL for a validated destination, always on the web
 * base URL's origin, with the attempt's own outcome parameters appended.
 */
export function mcpReturnUrl(
  webBaseUrl: string,
  returnTo: string | null | undefined,
  params: Record<string, string>,
): string {
  const base = new URL(webBaseUrl);
  const path = parseMcpReturnTo(returnTo) ?? DEFAULT_MCP_RETURN_TO;
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    // Unreachable for a validated path; fail closed rather than redirect away.
    return new URL(DEFAULT_MCP_RETURN_TO, base).href;
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

/** Where an unknown, expired or replayed callback goes: fixed, no input. */
export function mcpInvalidAttemptUrl(webBaseUrl: string): string {
  const url = new URL(DEFAULT_MCP_RETURN_TO, new URL(webBaseUrl));
  url.searchParams.set("mcpOAuth", "invalid");
  return url.href;
}
