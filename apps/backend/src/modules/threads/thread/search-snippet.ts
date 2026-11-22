/**
 * The part of `content` around the first case-insensitive occurrence of
 * `query`, with whitespace collapsed and `…` where text was cut. Falls back to
 * the start of the text when the query is not found verbatim.
 */
export function buildSearchSnippet(
  content: string,
  query: string,
  width = 120,
): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;

  const hit = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const center = hit < 0 ? 0 : hit + Math.floor(query.trim().length / 2);
  let start = Math.max(0, center - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  start = Math.max(0, end - width);

  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
