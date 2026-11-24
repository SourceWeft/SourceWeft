/**
 * Normalizes an HTTP entity tag so the same resource compares and hashes the
 * same across servers, server versions and transfer codings. Different WebDAV
 * servers present the tag differently: WsgiDAV reports the PROPFIND `getetag`
 * unquoted but the GET `ETag` header quoted; a gzip- or brotli-aware server
 * weakens it (`W/"x"`) or appends a content-coding suffix (`"x-gzip"`). A raw
 * `!==` between any two of those forms is a false mismatch.
 *
 * Normalization strips, in order: a weak-validator `W/` prefix, one pair of
 * surrounding double quotes, and a trailing `-gzip`/`-br` content-coding token.
 * Returns null for a null, empty or whitespace-only tag.
 */
export function normalizeEtag(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = raw.trim();
  if (value === "") return null;
  if (/^W\//i.test(value)) value = value.slice(2).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  value = value.replace(/-(?:gzip|br)$/i, "");
  return value === "" ? null : value;
}
