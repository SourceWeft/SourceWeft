/** Longest note HTML the converter reads; the rest is ignored. */
const MAX_INPUT_CHARS = 1_000_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Closes a paragraph-like block: separated from its neighbours by a blank line. */
const PARAGRAPH_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "blockquote",
  "pre",
]);

/** Content of these elements is never text. */
const HIDDEN_TAGS = new Set(["script", "style"]);

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z]{2,6});/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        const valid =
          Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          (code < 0xd800 || code > 0xdfff);
        return valid ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** `[closing, name]` of the tag whose text between `<` and `>` is `inner`. */
function tagOf(inner: string): { closing: boolean; name: string } | null {
  const match = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
  if (!match) return null;
  return {
    closing: match[1] === "/",
    name: (match[2] as string).toLowerCase(),
  };
}

/**
 * Plain text of a Zotero note's HTML subset. Block elements become line
 * breaks (`<li>` also gets `- `), the entities `&amp; &lt; &gt; &quot; &#39;
 * &nbsp;` and numeric references are decoded, every other tag is dropped, and
 * `script`/`style` content is removed. Input is capped at 1,000,000
 * characters. The scan is linear and never throws, whatever the markup.
 */
export function noteHtmlToText(html: string): string {
  if (typeof html !== "string") return "";
  const source =
    html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html;
  const out: string[] = [];
  // True while only spaces follow the last line break (or nothing was written).
  let atLineStart = true;
  const text = (raw: string): void => {
    const piece = decodeEntities(raw).replace(/\s+/g, " ");
    if (piece === "") return;
    out.push(piece);
    if (piece.trim() !== "") atLineStart = false;
  };
  const lineBreak = (blank: boolean): void => {
    out.push(blank ? "\n\n" : "\n");
    atLineStart = true;
  };
  let i = 0;
  let nextGt = -2; // -2: not searched yet, -1: there is none
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      text(source.slice(i));
      break;
    }
    if (lt > i) text(source.slice(i, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    // The next ">" is remembered so a run of stray "<" costs one search.
    if (nextGt !== -1 && nextGt <= lt) nextGt = source.indexOf(">", lt + 1);
    else if (nextGt === -2) nextGt = source.indexOf(">", lt + 1);
    const gt = nextGt;
    if (gt === -1) {
      // An unterminated tag: what follows is markup noise, not content.
      break;
    }
    const tag = tagOf(source.slice(lt + 1, gt));
    i = gt + 1;
    if (!tag) {
      // "<" not followed by a tag name (`a < b>`): keep it as text.
      i = lt + 1;
      text("<");
      continue;
    }
    if (!tag.closing && HIDDEN_TAGS.has(tag.name)) {
      const selfClosing = source[gt - 1] === "/";
      if (!selfClosing) {
        const closer = new RegExp(`</${tag.name}(?=[\\s/>])`, "gi");
        closer.lastIndex = i;
        const found = closer.exec(source);
        if (!found) break;
        const closeEnd = source.indexOf(">", found.index);
        if (closeEnd === -1) break;
        i = closeEnd + 1;
      }
      continue;
    }
    if (tag.name === "br") {
      lineBreak(false);
    } else if (tag.name === "li") {
      if (!atLineStart) lineBreak(false);
      if (!tag.closing) {
        out.push("- ");
        atLineStart = false;
      }
    } else if (PARAGRAPH_TAGS.has(tag.name)) {
      lineBreak(true);
    }
  }

  return out
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
