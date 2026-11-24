import { WebDavError } from "./errors";
import { MAX_PATH_LENGTH, MAX_ROOT_LENGTH } from "./limits";

const CONTROL = /[\u0000-\u001F\u007F\\]/;

function invalid(): never {
  throw new WebDavError("WEBDAV_PATH_INVALID");
}

/** Splits an already decoded path into segments: empty and `.` segments are
 * dropped (`//` collapses), `..` is refused. */
function segmentsOf(path: string): string[] {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) invalid();
  if (CONTROL.test(path)) invalid();
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") invalid();
    segments.push(segment);
  }
  return segments;
}

/**
 * Normalizes a decoded path: leading slash, `//` collapsed, `.` dropped, `..`
 * and control characters refused. A trailing slash is kept if present (the
 * root is always `/`). The input is NOT percent-decoded: `100%25` is a folder
 * literally named that.
 */
export function normalizePath(path: string): string {
  const segments = segmentsOf(path);
  if (segments.length === 0) return "/";
  const trailing = path.endsWith("/") ? "/" : "";
  return `/${segments.join("/")}${trailing}`;
}

/** A selected root: {@link normalizePath} plus a trailing slash. */
export function normalizeRoot(path: string): string {
  const segments = segmentsOf(path);
  const root = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  if (root.length > MAX_ROOT_LENGTH) invalid();
  return root;
}

/** Equal paths, ignoring a trailing slash (servers disagree about it for
 * collections). Case is significant. */
export function samePath(a: string, b: string): boolean {
  const trim = (value: string) =>
    value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  return trim(a) === trim(b);
}

/** Decodes one raw path segment exactly once. Null when it cannot be a single
 * safe segment (bad escape, NUL or other control, separator, `.`/`..`). */
function decodeSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === "." || decoded === "..") return null;
  if (decoded.includes("/") || CONTROL.test(decoded)) return null;
  return decoded;
}

/** The raw (still encoded) path of an absolute-path or absolute-URL href on
 * the endpoint's origin; null for anything else. The URL parser is NOT used on
 * the path so `.`/`..` segments are seen, not silently resolved. */
function rawPathOf(endpoint: URL, href: string): string | null {
  const value = href.trim();
  let path: string;
  if (value.startsWith("/")) {
    path = value;
  } else {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(value);
    if (match === null) return null;
    let origin: string;
    try {
      origin = new URL(`${match[1]}://${match[2]}`).origin;
    } catch {
      return null;
    }
    if (origin !== endpoint.origin) return null;
    path = match[3] || "/";
  }
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

function decodedSegments(rawPath: string): string[] | null {
  const out: string[] = [];
  for (const raw of rawPath.split("/")) {
    if (raw === "") continue;
    const segment = decodeSegment(raw);
    if (segment === null) return null;
    out.push(segment);
  }
  return out;
}

/**
 * Turns a multistatus `href` into the decoded path relative to the endpoint's
 * base path (`/Documents/a.txt`; the endpoint itself is `/`). Each segment is
 * percent-decoded once; duplicate slashes collapse; there is no trailing
 * slash (see {@link samePath}). Null when the href is on another origin,
 * outside the base path, relative, or contains `.`/`..`, an encoded separator,
 * a control character or a malformed escape.
 */
export function toExternalId(endpoint: URL, href: string): string | null {
  const rawPath = rawPathOf(endpoint, href);
  if (rawPath === null) return null;
  const target = decodedSegments(rawPath);
  const base = decodedSegments(endpoint.pathname);
  if (target === null || base === null) return null;
  if (target.length < base.length) return null;
  for (let i = 0; i < base.length; i += 1) {
    if (target[i] !== base[i]) return null;
  }
  const rest = target.slice(base.length);
  const id = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return id.length > MAX_PATH_LENGTH ? null : id;
}

/** The absolute request URL for a decoded path under the endpoint: each
 * segment is percent-encoded, a trailing slash is kept. */
export function toRequestUrl(endpoint: URL, path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter((s) => s !== "");
  let encoded: string;
  try {
    encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  } catch {
    return invalid();
  }
  const trailing = normalized.endsWith("/") && segments.length > 0 ? "/" : "";
  const url = new URL(endpoint.href);
  url.pathname = `${endpoint.pathname}${encoded}${trailing}`;
  url.search = "";
  url.hash = "";
  return url.href;
}
