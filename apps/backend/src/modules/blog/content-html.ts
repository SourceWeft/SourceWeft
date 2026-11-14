/**
 * HTML helpers shared by the blog content renderers (Notion blocks and
 * Markdown files), so both sources produce the same markup for the article
 * styles and the same text measures.
 */

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

export function compactText(value: string) {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

export function slugifyHeading(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

export function estimateReadingTime(text: string) {
  const cjkCharacters =
    text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)
      ?.length ?? 0;
  const words = text
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const readingUnits = words + cjkCharacters / 2;

  return Math.max(1, Math.ceil(readingUnits / 225));
}
