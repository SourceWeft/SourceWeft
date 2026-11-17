// Total (never-throwing) converter from Atlassian Document Format (ADF) to
// Markdown, shared by Jira and Confluence. `adfToMarkdown`
// never throws: anything it cannot make sense of renders as "" or as the
// concatenated text of its descendants, and the whole call is wrapped so a
// defensive bug here never breaks an issue/comment/page read.

const MAX_DEPTH = 50;

type AdfNode = Record<string, unknown>;

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getContent(node: AdfNode): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function getAttrs(node: AdfNode): AdfNode {
  return isNode(node.attrs) ? node.attrs : {};
}

/** Plain concatenation of every descendant `text` node's `text`, ignoring type
 * and marks. Used for nodes past the depth cap and for node types this
 * converter does not otherwise recognize. */
function collectText(node: unknown): string {
  if (!isNode(node)) return "";
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  return getContent(node).map(collectText).join("");
}

/** Renders a list of block-level nodes, each trimmed, joined with exactly one
 * blank line between non-empty blocks. Trimming each block before joining is
 * what keeps sibling blocks to at most one blank line apart, at every nesting
 * level, without ever touching a leaf's own content (e.g. a fenced code
 * block's literal blank lines) — so there is no separate, document-wide
 * blank-line collapse that could rewrite a code block's body. */
function renderBlocks(nodes: unknown[], depth: number): string {
  return nodes
    .filter(isNode)
    .map((node) => renderNode(node, depth).trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/** Renders a list of inline nodes (text, hardBreak, mention, emoji, cards, …)
 * concatenated with no separator. */
function renderInline(nodes: unknown[], depth: number): string {
  return nodes
    .filter(isNode)
    .map((node) => renderNode(node, depth))
    .join("");
}

function headingLevel(attrs: AdfNode): number {
  const raw = attrs.level;
  const level = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return Math.min(6, Math.max(1, level));
}

function renderText(node: AdfNode): string {
  let value = typeof node.text === "string" ? node.text : "";
  const marks = Array.isArray(node.marks) ? node.marks : [];
  for (const mark of marks) {
    if (!isNode(mark)) continue;
    switch (mark.type) {
      case "strong":
        value = `**${value}**`;
        break;
      case "em":
        value = `*${value}*`;
        break;
      case "code":
        value = `\`${value}\``;
        break;
      case "strike":
        value = `~~${value}~~`;
        break;
      case "link": {
        const attrs = getAttrs(mark);
        const href = typeof attrs.href === "string" ? attrs.href : "";
        if (href.startsWith("http://") || href.startsWith("https://")) {
          value = `[${value}](${href})`;
        }
        break;
      }
      default:
        break;
    }
  }
  return value;
}

function renderListItem(item: AdfNode, depth: number, indent: string, marker: string): string {
  const children = getContent(item).filter(isNode);
  if (children.length === 0) return `${indent}${marker}`.trimEnd();

  const [first, ...rest] = children;
  const firstLine =
    first !== undefined
      ? first.type === "paragraph"
        ? renderInline(getContent(first), depth + 1)
        : renderNode(first, depth + 1).trim()
      : "";
  let result = `${indent}${marker}${firstLine}`;

  for (const child of rest) {
    if (child.type === "bulletList" || child.type === "orderedList") {
      const nested = renderList(child, depth + 1, `${indent}  `);
      if (nested.length > 0) result += `\n${nested}`;
    } else {
      const rendered = renderNode(child, depth + 1).trim();
      if (rendered.length > 0) result += `\n${indent}  ${rendered}`;
    }
  }
  return result;
}

function renderList(node: AdfNode, depth: number, indent: string): string {
  const ordered = node.type === "orderedList";
  const items = getContent(node).filter(isNode);
  return items
    .map((item, index) =>
      renderListItem(item, depth, indent, ordered ? `${index + 1}. ` : "- "),
    )
    .join("\n");
}

function renderTableCell(cell: AdfNode, depth: number): string {
  const inner = renderBlocks(getContent(cell), depth + 1).trim();
  return inner.replace(/\n/g, " ").replace(/\|/g, "\\|");
}

function renderTable(node: AdfNode, depth: number): string {
  const rows = getContent(node).filter(isNode);
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const cells = getContent(row)
      .filter(isNode)
      .map((cell) => renderTableCell(cell, depth));
    lines.push(`| ${cells.join(" | ")} |`);
    if (index === 0) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
    }
  });
  return lines.join("\n");
}

function renderBlockquote(node: AdfNode, depth: number): string {
  const inner = renderBlocks(getContent(node), depth + 1).trim();
  if (inner.length === 0) return ">";
  return inner
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function renderCodeBlock(node: AdfNode, depth: number): string {
  const attrs = getAttrs(node);
  const language = typeof attrs.language === "string" ? attrs.language : "";
  const code = renderInline(getContent(node), depth + 1);
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function renderNode(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return collectText(node);

  switch (node.type) {
    case "paragraph":
      return renderInline(getContent(node), depth + 1);
    case "heading": {
      const level = headingLevel(getAttrs(node));
      return `${"#".repeat(level)} ${renderInline(getContent(node), depth + 1)}`;
    }
    case "bulletList":
    case "orderedList":
      return renderList(node, depth + 1, "");
    case "codeBlock":
      return renderCodeBlock(node, depth);
    case "blockquote":
      return renderBlockquote(node, depth);
    case "table":
      return renderTable(node, depth);
    case "rule":
      return "---";
    case "hardBreak":
      return "\n";
    case "text":
      return renderText(node);
    case "mention": {
      const attrs = getAttrs(node);
      if (typeof attrs.text === "string") return attrs.text;
      if (typeof attrs.id === "string") return `@${attrs.id}`;
      return "";
    }
    case "emoji": {
      const attrs = getAttrs(node);
      if (typeof attrs.text === "string") return attrs.text;
      if (typeof attrs.shortName === "string") return attrs.shortName;
      return "";
    }
    case "inlineCard":
    case "blockCard": {
      const attrs = getAttrs(node);
      const url = typeof attrs.url === "string" ? attrs.url : "";
      return url.startsWith("http://") || url.startsWith("https://") ? url : "";
    }
    case "mediaSingle":
    case "media":
    case "mediaGroup":
      return "";
    default:
      return collectText(node);
  }
}

/**
 * Converts an Atlassian Document Format document to Markdown. Total: never
 * throws, and returns `""` for anything that is not an object with a
 * `content` array. Recursion depth is capped at 50; deeper content renders as
 * its concatenated text. Output is trimmed and has at most one blank line
 * between blocks.
 */
export function adfToMarkdown(doc: unknown): string {
  try {
    if (!isNode(doc)) return "";
    if (!Array.isArray(doc.content)) return "";
    return renderBlocks(doc.content, 1).trim();
  } catch {
    return "";
  }
}
