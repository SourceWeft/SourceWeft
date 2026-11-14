import { createHash } from "node:crypto";
import { Lexer, type Token, type Tokens } from "marked";
import {
  compactText,
  escapeAttribute,
  escapeHtml,
  estimateReadingTime,
  slugifyHeading,
} from "./content-html";
import type { RenderedBlogContent } from "./notion-renderer";

/** A Markdown construct the importer refuses, with the reason. */
export class UnsupportedMarkdownError extends Error {}

type Rendered = { html: string; text: string };

const SITE_HOSTS = new Set(["sourceweft.com", "www.sourceweft.com"]);

/**
 * Markdown article body → the HTML shapes the Notion renderer produces, so the
 * article styles and the public pages treat both sources alike: `#`/`##` become
 * `<h2 id>`, deeper headings `<h3 id>`, tables sit in `.blog-table`, and raw
 * HTML in the source is shown as text, never emitted as markup.
 */
export function renderMarkdownContent(markdown: string): RenderedBlogContent {
  const rendered = renderBlocks(Lexer.lex(markdown));
  const contentHtml = rendered.map((part) => part.html).filter(Boolean).join("\n");
  const contentText = compactText(
    rendered
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n"),
  );

  return {
    contentHtml,
    contentText,
    contentHash: createHash("sha256")
      .update(JSON.stringify({ html: contentHtml, text: contentText }))
      .digest("hex"),
    readingTimeMinutes: estimateReadingTime(contentText),
    assetIds: [],
  };
}

function renderBlocks(tokens: Token[]): Rendered[] {
  return tokens.map(renderBlock).filter((part) => part.html || part.text);
}

function renderBlock(token: Token): Rendered {
  switch (token.type) {
    case "space":
      return { html: "", text: "" };
    case "heading": {
      const heading = token as Tokens.Heading;
      const text = plainText(heading.tokens).trim();
      const tag = heading.depth <= 2 ? "h2" : "h3";
      return {
        html: `<${tag} id="${escapeAttribute(slugifyHeading(text))}">${renderInline(heading.tokens)}</${tag}>`,
        text,
      };
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return {
        html: `<p>${renderInline(paragraph.tokens)}</p>`,
        text: plainText(paragraph.tokens).trim(),
      };
    }
    case "text": {
      // A tight list item's content arrives as a block-level text token.
      const text = token as Tokens.Text;
      return {
        html: renderInline(text.tokens ?? [text]),
        text: plainText(text.tokens ?? [text]).trim(),
      };
    }
    case "list":
      return renderList(token as Tokens.List);
    case "blockquote": {
      const parts = renderBlocks((token as Tokens.Blockquote).tokens);
      return {
        html: `<blockquote>${parts.map((part) => part.html).join("\n")}</blockquote>`,
        text: joinText(parts),
      };
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.trim().split(/\s+/)[0];
      const attribute = language
        ? ` class="language-${escapeAttribute(language)}"`
        : "";
      return {
        html: `<pre><code${attribute}>${escapeHtml(code.text)}</code></pre>`,
        text: code.text,
      };
    }
    case "table":
      return renderTable(token as Tokens.Table);
    case "hr":
      return { html: "<hr>", text: "" };
    case "html": {
      // Comments are an author's notes, not content. Any other raw HTML is
      // shown as the text it is.
      const raw = (token as Tokens.HTML).text.trim();
      if (!raw || /^<!--[\s\S]*-->$/.test(raw)) {
        return { html: "", text: "" };
      }
      return { html: `<p>${escapeHtml(raw)}</p>`, text: raw };
    }
    default:
      throw new UnsupportedMarkdownError(
        `Unsupported Markdown block: ${token.type}`,
      );
  }
}

function renderList(list: Tokens.List): Rendered {
  const tag = list.ordered ? "ol" : "ul";
  const start =
    list.ordered && typeof list.start === "number" && list.start !== 1
      ? ` start="${list.start}"`
      : "";
  const items = list.items.map((item) => {
    const parts = renderBlocks(
      item.tokens.filter((child) => child.type !== "checkbox"),
    );
    const html = parts.map((part) => part.html).join("\n");
    const checkbox = item.task
      ? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> `
      : "";
    return { html: `<li>${checkbox}${html}</li>`, text: joinText(parts) };
  });

  return {
    html: `<${tag}${start}>${items.map((item) => item.html).join("")}</${tag}>`,
    text: items
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n"),
  };
}

function renderTable(table: Tokens.Table): Rendered {
  const head = `<thead><tr>${table.header
    .map((cell) => `<th scope="col">${renderInline(cell.tokens)}</th>`)
    .join("")}</tr></thead>`;
  const body =
    table.rows.length > 0
      ? `<tbody>${table.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${renderInline(cell.tokens)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody>`
      : "";
  const rowText = (cells: Tokens.TableCell[]) =>
    cells
      .map((cell) => plainText(cell.tokens).trim())
      .filter(Boolean)
      .join(" | ");

  return {
    html: `<div class="blog-table"><table>${head}${body}</table></div>`,
    text: [table.header, ...table.rows].map(rowText).filter(Boolean).join("\n"),
  };
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : escapeHtml(literal(text));
    }
    case "escape":
      return escapeHtml((token as Tokens.Escape).text);
    case "strong":
      return `<strong>${renderInline((token as Tokens.Strong).tokens)}</strong>`;
    case "em":
      return `<em>${renderInline((token as Tokens.Em).tokens)}</em>`;
    case "del":
      return `<s>${renderInline((token as Tokens.Del).tokens)}</s>`;
    case "codespan":
      return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
    case "br":
      return "<br>";
    case "link":
      return renderLink(token as Tokens.Link);
    case "html":
      return escapeHtml((token as Tokens.HTML).text);
    case "image":
      throw new UnsupportedMarkdownError(
        "Images are not supported in Markdown articles yet",
      );
    default:
      throw new UnsupportedMarkdownError(
        `Unsupported Markdown inline element: ${token.type}`,
      );
  }
}

function renderLink(link: Tokens.Link): string {
  const label = renderInline(link.tokens);
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    throw new UnsupportedMarkdownError(
      `Link must be an absolute URL: ${link.href}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsupportedMarkdownError(
      `Link must use http or https: ${link.href}`,
    );
  }
  // Links into our own site are part of the site's structure and stay
  // followable; everything else carries the same rel as the Notion renderer.
  const rel = SITE_HOSTS.has(url.hostname)
    ? ""
    : ' rel="nofollow noopener noreferrer"';
  return `<a href="${escapeAttribute(link.href)}"${rel}>${label}</a>`;
}

function plainText(tokens: Token[]): string {
  return tokens
    .map((token): string => {
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return plainText(token.tokens);
      }
      if (token.type === "br") {
        return "\n";
      }
      if (token.type === "codespan") {
        return (token as Tokens.Codespan).text;
      }
      return "text" in token && typeof token.text === "string"
        ? literal(token as Tokens.Text)
        : "";
    })
    .join("");
}

/** A text token's characters, whether or not the lexer already escaped them. */
function literal(token: { text: string; escaped?: boolean }): string {
  return token.escaped ? decodeEntities(token.text) : token.text;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function joinText(parts: Rendered[]): string {
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}
