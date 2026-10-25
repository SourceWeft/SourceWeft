/**
 * One line of third-party text, safe to quote: no line breaks, control or
 * bidirectional-override characters, no backticks, capped in length. Used
 * wherever text from a repository or a registry is put into a document an
 * agent reads (the install guides), so it cannot start a new paragraph, close
 * a code span or pass for the guide's own words.
 */
export function untrustedLine(value: string, max: number) {
  const line = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}`]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
