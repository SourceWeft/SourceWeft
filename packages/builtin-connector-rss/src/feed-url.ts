import { redactUrlQuery } from "@sourceweft/contracts";

const FEED_URL_MAX_LENGTH = 2048;

export type FeedUrlRejection =
  "feed_url_invalid" | "feed_https_required" | "feed_credentials_not_allowed";

export type ParsedFeedUrl =
  { ok: true; url: URL } | { ok: false; reason: FeedUrlRejection };

/**
 * Validates a user-supplied feed URL: trimmed, at most 2048 characters, https
 * only, no `user:pass@` userinfo. The WHATWG parser lowercases the host. A
 * token query is allowed; callers must log only {@link redactFeedUrl}.
 */
export function parseFeedUrl(raw: string): ParsedFeedUrl {
  const value = raw.trim();
  if (value.length === 0 || value.length > FEED_URL_MAX_LENGTH) {
    return { ok: false, reason: "feed_url_invalid" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "feed_url_invalid" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "feed_https_required" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "feed_credentials_not_allowed" };
  }
  if (url.hostname === "") {
    return { ok: false, reason: "feed_url_invalid" };
  }
  return { ok: true, url };
}

/** `scheme://host/path` only: the query (which may hold a token) is dropped. */
export function redactFeedUrl(raw: string): string {
  return redactUrlQuery(raw);
}
