import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterMap,
  type TreeAdapter,
} from "parse5";

type Node = DefaultTreeAdapterMap["node"];

const SKIPPED = new Set([
  "script",
  "style",
  "iframe",
  "svg",
  "noscript",
  "template",
  "head",
]);

/** Separated from neighbours by a blank line. */
const PARAGRAPH = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
  "hr",
  "figure",
]);

/** Separated from neighbours by a line break. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "body",
  "caption",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "footer",
  "form",
  "header",
  "html",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "section",
  "summary",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Cheap check so plain text is returned untouched rather than re-flowed. */
const LOOKS_LIKE_HTML =
  /<[a-zA-Z!/]|&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

/** Most elements one document may create. parse5 rescans its open-element
 * stack for many tags, so the cost of hostile input is quadratic in how many
 * elements it opens: 20k nested divs take seconds, and `<div/>`, stray end
 * tags, foster-parented table content and nested templates all keep the stack
 * growing while the visible tree stays shallow. The element count bounds all
 * of them regardless of nesting shape, because the stack can never exceed it
 * (per-tag cost is bounded separately by {@link MAX_ATTRS_PER_TAG}). Real
 * feed items have a few hundred elements. */
const MAX_ELEMENTS = 3_000;

class TooManyElements extends Error {}

/** Most attributes one tag may carry. parse5's tokenizer checks every new
 * attribute against all earlier ones, so a single tag costs quadratic time in
 * its attribute count (60k attributes took 19 s) and the element cap cannot
 * see it. Real tags carry a few dozen at most. */
const MAX_ATTRS_PER_TAG = 128;

/** Elements whose content the tokenizer reads as text, not markup. */
const TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

const isSpace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isLetter = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * Follows the HTML tokenizer's attribute states from just after `<` (or `</`)
 * to the closing `>`, which is returned. Returns -1 when the tag is
 * unterminated or carries more than {@link MAX_ATTRS_PER_TAG} attributes.
 * Quoted values are skipped whole (a `>` inside one does not end the tag) and
 * every step advances, so the walk is linear in the tag's length.
 */
function scanTag(html: string, from: number): number {
  const n = html.length;
  let i = from;
  while (i < n) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 0x2f || c === 0x3e) break;
    i += 1;
  }
  let attrs = 0;
  while (i < n) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 0x2f) {
      i += 1;
      continue;
    }
    if (c === 0x3e) return i;
    attrs += 1;
    if (attrs > MAX_ATTRS_PER_TAG) return -1;
    i += 1; // a leading `=` belongs to the name
    while (i < n) {
      const d = html.charCodeAt(i);
      if (isSpace(d) || d === 0x2f || d === 0x3e || d === 0x3d) break;
      i += 1;
    }
    let j = i;
    while (j < n && isSpace(html.charCodeAt(j))) j += 1;
    if (j >= n) return -1;
    if (html.charCodeAt(j) !== 0x3d) {
      i = j;
      continue;
    }
    j += 1;
    while (j < n && isSpace(html.charCodeAt(j))) j += 1;
    if (j >= n) return -1;
    const q = html.charCodeAt(j);
    if (q === 0x22 || q === 0x27) {
      const close = html.indexOf(q === 0x22 ? '"' : "'", j + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else if (q === 0x3e) {
      return j;
    } else {
      i = j;
      while (i < n) {
        const d = html.charCodeAt(i);
        if (isSpace(d) || d === 0x3e) break;
        i += 1;
      }
    }
  }
  return -1;
}

/**
 * Cuts the markup at the first tag with too many attributes or that is never
 * closed, so only what precedes it is parsed. Comments, `<!...>` / `<?...>`
 * declarations and the content of text elements (script, style, ...) are
 * skipped the way the tokenizer reads them, so markup-looking text inside
 * them cannot hide a real tag. Every step advances past what it consumed, so
 * the scan is linear. It is a guard against stalls, not a second parser:
 * exotic constructs (script-data escapes, HTML integration points inside
 * svg) are not modelled.
 */
function cutAtOversizedTag(html: string): string {
  const commentEnd = /--!?>/g;
  let foreign = 0; // open svg/math elements: their children are plain elements
  let lt = html.indexOf("<");
  while (lt !== -1) {
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 0x21 && html.startsWith("<!--", lt)) {
      const body = lt + 4;
      if (html.startsWith(">", body)) {
        lt = html.indexOf("<", body + 1);
      } else if (html.startsWith("->", body)) {
        lt = html.indexOf("<", body + 2);
      } else {
        commentEnd.lastIndex = body;
        const m = commentEnd.exec(html);
        if (m === null) return html;
        lt = html.indexOf("<", m.index + m[0].length);
      }
      continue;
    }
    const closing = c1 === 0x2f;
    if (!isLetter(closing ? html.charCodeAt(lt + 2) : c1)) {
      if (c1 === 0x21 || c1 === 0x3f || closing) {
        const gt = html.indexOf(">", lt + 1);
        if (gt === -1) return html;
        lt = html.indexOf("<", gt + 1);
      } else {
        lt = html.indexOf("<", lt + 1);
      }
      continue;
    }
    const nameStart = lt + (closing ? 2 : 1);
    const end = scanTag(html, nameStart);
    if (end === -1) return html.slice(0, lt);
    let nameEnd = nameStart;
    while (nameEnd < end) {
      const c = html.charCodeAt(nameEnd);
      if (isSpace(c) || c === 0x2f) break;
      nameEnd += 1;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    if (name === "svg" || name === "math") {
      foreign = closing ? Math.max(0, foreign - 1) : foreign + 1;
    } else if (!closing && foreign === 0) {
      if (name === "plaintext") return html;
      if (TEXT_ELEMENTS.has(name)) {
        const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
        close.lastIndex = end + 1;
        const m = close.exec(html);
        if (m === null) return html;
        lt = m.index;
        continue;
      }
    }
    lt = html.indexOf("<", end + 1);
  }
  return html;
}

/**
 * Parses (after {@link cutAtOversizedTag}) with a tree adapter that counts the elements the parser creates and
 * aborts once the cap is exceeded, keeping what was built so far. Counting in
 * the parser's own adapter (not guessing from the markup) means no syntax can
 * hide an element from the count.
 */
function parseCapped(html: string): DefaultTreeAdapterMap["document"] {
  let root: DefaultTreeAdapterMap["document"] | undefined;
  let elements = 0;
  const treeAdapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createDocument() {
      root = defaultTreeAdapter.createDocument();
      return root;
    },
    createElement(tagName, namespaceURI, attrs) {
      elements += 1;
      if (elements > MAX_ELEMENTS) throw new TooManyElements();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
  };
  try {
    return parse(cutAtOversizedTag(html), { treeAdapter });
  } catch (error) {
    if (error instanceof TooManyElements && root !== undefined) return root;
    throw error;
  }
}

/**
 * Converts an HTML fragment to plain text. Parsing is delegated to parse5
 * (which decodes entities and never executes anything); the tree is walked
 * iteratively so deeply nested markup cannot overflow the call stack.
 */
export function htmlToText(html: string): string {
  if (!LOOKS_LIKE_HTML.test(html)) return html.trim();

  const document = parseCapped(html);
  const out: string[] = [];
  // Newlines currently at the end of `out`; Infinity at the very start so no
  // leading blank lines are produced.
  let trailingNewlines = Infinity;

  const emit = (text: string): void => {
    if (text.length === 0) return;
    out.push(text);
    const stripped = text.replace(/\n+$/, "");
    trailingNewlines =
      stripped.length === 0
        ? trailingNewlines + text.length
        : text.length - stripped.length;
  };
  const ensureNewlines = (count: number): void => {
    if (trailingNewlines === Infinity) return;
    if (trailingNewlines < count) emit("\n".repeat(count - trailingNewlines));
  };

  const stack: Array<{ node: Node; exit: boolean }> = [
    { node: document as Node, exit: false },
  ];
  while (stack.length > 0) {
    const { node, exit } = stack.pop()!;
    if (node.nodeName === "#text") {
      const value = (node as { value: string }).value.replace(/\s+/g, " ");
      // Whitespace between tags (pretty-printed markup) is not content.
      if (value === " " && trailingNewlines > 0) continue;
      emit(value);
      continue;
    }
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") {
      continue;
    }
    const tag = "tagName" in node ? node.tagName : "";
    if (exit) {
      if (PARAGRAPH.has(tag)) ensureNewlines(2);
      else if (BLOCK.has(tag)) ensureNewlines(1);
      continue;
    }
    if (SKIPPED.has(tag)) continue;
    if (tag === "br") {
      emit("\n");
      continue;
    }
    if (PARAGRAPH.has(tag)) ensureNewlines(2);
    else if (BLOCK.has(tag)) ensureNewlines(1);
    stack.push({ node, exit: true });
    const children = "childNodes" in node ? node.childNodes : [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i]!, exit: false });
    }
  }

  return out
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
