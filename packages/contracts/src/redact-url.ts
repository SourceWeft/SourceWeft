/**
 * Reduces a URL to `scheme://host[:port]/path`, dropping userinfo, query and
 * fragment so a token carried in the query never reaches a log line, error or
 * stored metadata. Returns "" when the value is not a valid http(s) URL.
 */
export function redactUrlQuery(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return `${url.protocol}//${url.host}${url.pathname}`;
}
