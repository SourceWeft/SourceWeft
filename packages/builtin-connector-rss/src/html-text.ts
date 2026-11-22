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
 * of them regardless of shape, because the stack can never exceed it. Real
 * feed items have a few hundred elements. */
const MAX_ELEMENTS = 3_000;

class TooManyElements extends Error {}

/**
 * Parses with a tree adapter that counts the elements the parser creates and
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
    return parse(html, { treeAdapter });
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
