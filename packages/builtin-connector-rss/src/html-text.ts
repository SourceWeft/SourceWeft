import { parse, type DefaultTreeAdapterMap } from "parse5";

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

/** Elements with no content, or whose end tag HTML lets authors omit; they do
 * not deepen the tree on their own, so they are not counted as nesting. */
const NOT_NESTING = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "tbody",
  "thead",
  "tfoot",
  "option",
  "optgroup",
  "colgroup",
  "caption",
]);

/** Deeper nesting than any real feed content. parse5's tree construction
 * rescans its open-element stack per tag, so unbounded nesting is quadratic
 * (200k nested divs take minutes) and one hostile feed item would stall a sync. */
const MAX_NESTING_DEPTH = 512;

/** Cuts the markup where element nesting first exceeds the cap. Linear time. */
function truncateExcessiveNesting(html: string): string {
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/g;
  let depth = 0;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    const name = m[2]!.toLowerCase();
    if (NOT_NESTING.has(name)) continue;
    if (m[1] === "/") {
      depth = Math.max(0, depth - 1);
    } else if (!m[0].endsWith("/>")) {
      depth += 1;
      if (depth > MAX_NESTING_DEPTH) return html.slice(0, m.index);
    }
  }
  return html;
}

/**
 * Converts an HTML fragment to plain text. Parsing is delegated to parse5
 * (which decodes entities and never executes anything); the tree is walked
 * iteratively so deeply nested markup cannot overflow the call stack.
 */
export function htmlToText(html: string): string {
  if (!LOOKS_LIKE_HTML.test(html)) return html.trim();

  const document = parse(truncateExcessiveNesting(html));
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
