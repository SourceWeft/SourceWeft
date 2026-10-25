/**
 * One line of third-party text, safe to quote: no line breaks, control or
 * bidirectional-override, zero-width or other format characters, no backticks, capped in length. Used
 * wherever text from a repository or a registry is put into a document an
 * agent reads (the install guides), so it cannot start a new paragraph, close
 * a code span or pass for the guide's own words.
 */
export function untrustedLine(value: string, max: number) {
  const line = value
    // Format characters (zero-width, bidi, the byte order mark and the tag
    // block that can carry text no reader sees) and variation selectors go
    // with the controls.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFE00-\uFE0F\u{E0100}-\u{E01EF}`]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
