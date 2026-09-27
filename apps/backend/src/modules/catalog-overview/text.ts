/**
 * Text rules every kind's output parser applies to what the model wrote: it
 * is model output from third-party content, so it is reduced to plain text,
 * capped, and read tolerantly when it arrives as text instead of structured
 * output. Pure: no model, database or configuration.
 */

/**
 * Model output as plain text: no tags, no markdown links or emphasis, no
 * control characters, whitespace collapsed. What is left is shown as text.
 */
export function toPlainText(value: string): string {
  return (
    value
      // Markdown images and links keep their words, lose their targets.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Tags (and anything shaped like one).
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      // Bare URLs are not something an overview should hand out.
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      // Headings, list bullets and emphasis markers at word edges.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/`+/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Cut to `limit` characters, at a word boundary where there is one near the
 * end, with an ellipsis. Counts code points, so CJK and emoji are not split.
 */
export function capLength(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const cut = chars.slice(0, limit - 1).join("");
  const space = cut.lastIndexOf(" ");
  const trimmed = space >= limit * 0.6 ? cut.slice(0, space) : cut;
  return `${trimmed.replace(/[\s,;:.，。；：、]+$/u, "")}…`;
}

/** The first JSON object in a text answer (fenced or bare); null if none. */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
