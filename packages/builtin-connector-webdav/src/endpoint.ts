import { redactUrlQuery } from "@sourceweft/contracts";
import { WebDavError } from "./errors";
import { ENDPOINT_MAX_LENGTH } from "./limits";

/**
 * Validates a user-supplied WebDAV base URL: trimmed, at most 2048 characters,
 * http or https, no `user:pass@` userinfo, no query, no fragment. A trailing
 * slash is added to the base path. Plain http and private addresses are legal
 * here: the credentialed fetch scope enforces the deployment's allowlist.
 * Rejections carry a fixed message, never the value (it may hold a secret).
 */
export function parseEndpoint(raw: string): URL {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0 || value.length > ENDPOINT_MAX_LENGTH) {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  // The URL parser silently drops tabs and newlines and encodes spaces, so
  // anything of that kind is refused before parsing.
  if (/[\s\u0000-\u001F\u007F]/.test(value)) {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  if (value.includes("?") || value.includes("#")) {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes("@")) {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    throw new WebDavError("WEBDAV_ENDPOINT_INVALID");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

/** `scheme://host/path` only: safe to log. */
export function redactEndpoint(endpoint: URL): string {
  return redactUrlQuery(endpoint.href);
}
