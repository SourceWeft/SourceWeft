import { isIP } from "node:net";

/**
 * SSRF guard for user-supplied URLs.
 *
 * DUPLICATE — kept on purpose. `@sourceweft/builtin-tool-web-search`
 * (`src/url-safety.ts`) carries the same blocklist, `isPrivateIpv4`,
 * `isBlockedHostname` and `validatePublicHttpUrl`. **A change to the blocking
 * rules here must be made there too, in the same change.**
 *
 * The two are not extracted into one module because they are not actually the
 * same file: this copy uses Node's `isIP`, while the web-search copy hand-rolls
 * an equivalent so that module stays free of `node:net` and usable from client
 * code. Collapsing them would force one side onto the other's IP detection —
 * either weakening this check to a regex, or dragging `node:net` into a client
 * bundle. Neither package depends on the other, so a shared home would also
 * mean a new package or a dependency edge invented purely for two dozen lines.
 *
 * For security code, an explicit duplicate that both sides can read beats an
 * abstraction that quietly changes what one of them blocks.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  if (isIP(normalized) === 4) {
    return isPrivateIpv4(normalized);
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
  }
  return false;
}

export function validatePublicHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL must be a valid http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (!url.hostname || isBlockedHostname(url.hostname)) {
    throw new Error("URL host is not allowed.");
  }
  return url.toString();
}
