import { createHash } from "node:crypto";
import {
  listBlockChildren,
  type NotionBlock,
  type NotionRichText,
} from "./notion-client";
import { richTextToPlainText } from "./notion-properties";
import {
  buildBlogAssetId,
  upsertBlogAsset,
  type BlogAssetKind,
} from "./repository";
import {
  compactText,
  escapeAttribute,
  escapeHtml,
  estimateReadingTime,
  slugifyHeading,
} from "./content-html";
import { downloadAndUploadBlogAsset } from "./public-storage";
import type { BlogLocale } from "./locales";

type RichTextPayload = {
  rich_text?: NotionRichText[];
  caption?: NotionRichText[];
  language?: string;
  checked?: boolean;
  text?: { content?: string; link?: { url?: string } | null };
  type?: "file" | "external";
  file?: { url?: string; expiry_time?: string };
  external?: { url?: string };
  url?: string;
};

type RenderContext = {
  articleId: string;
  locale: BlogLocale;
  postId: string;
  postTitle: string;
  dryRun: boolean;
  assetIds: string[];
};

export type RenderedBlogContent = {
  contentHtml: string;
  contentText: string;
  contentHash: string;
  readingTimeMinutes: number;
  assetIds: string[];
};

export async function renderNotionPageContent(input: {
  pageId: string;
  articleId: string;
  locale: BlogLocale;
  postId: string;
  postTitle: string;
  dryRun: boolean;
}) {
  const blocks = await listBlockChildren(input.pageId);
  const context: RenderContext = {
    articleId: input.articleId,
    locale: input.locale,
    postId: input.postId,
    postTitle: input.postTitle,
    dryRun: input.dryRun,
    assetIds: [],
  };
  const rendered = await renderBlocks(blocks, context);
  const contentText = compactText(rendered.textParts.join("\n\n"));
  const contentHtml = rendered.htmlParts.join("\n");

  return {
    contentHtml,
    contentText,
    contentHash: createHash("sha256")
      .update(JSON.stringify({ html: contentHtml, text: contentText }))
      .digest("hex"),
    readingTimeMinutes: estimateReadingTime(contentText),
    assetIds: context.assetIds,
  } satisfies RenderedBlogContent;
}

async function renderBlocks(blocks: NotionBlock[], context: RenderContext) {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) {
      continue;
    }

    if (
      block.type === "bulleted_list_item" ||
      block.type === "numbered_list_item"
    ) {
      const listType = block.type;
      const tag = listType === "bulleted_list_item" ? "ul" : "ol";
      const items: string[] = [];
      while (blocks[index]?.type === listType) {
        const listBlock = blocks[index];
        if (!listBlock) {
          break;
        }
        const item = await renderListItem(listBlock, context);
        items.push(item.html);
        textParts.push(item.text);
        index += 1;
      }
      index -= 1;
      htmlParts.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const rendered = await renderBlock(block, context);
    if (rendered.html) {
      htmlParts.push(rendered.html);
    }
    if (rendered.text) {
      textParts.push(rendered.text);
    }
  }

  return { htmlParts, textParts };
}

async function renderBlock(block: NotionBlock, context: RenderContext) {
  const payload = getPayload(block);
  const richText = payload.rich_text ?? [];
  const plainText = richTextToPlainText(richText).trim();

  if (block.type === "paragraph") {
    const children = await renderChildBlocks(block, context);
    const html = richText.length > 0 ? `<p>${renderRichText(richText)}</p>` : "";
    return {
      html: [html, children.html].filter(Boolean).join("\n"),
      text: compactText([plainText, children.text].filter(Boolean).join("\n")),
    };
  }

  if (block.type === "heading_1" || block.type === "heading_2") {
    return {
      html: `<h2 id="${escapeAttribute(slugifyHeading(plainText))}">${renderRichText(richText)}</h2>`,
      text: plainText,
    };
  }

  if (block.type === "heading_3") {
    return {
      html: `<h3 id="${escapeAttribute(slugifyHeading(plainText))}">${renderRichText(richText)}</h3>`,
      text: plainText,
    };
  }

  if (block.type === "quote") {
    return {
      html: `<blockquote>${renderRichText(richText)}</blockquote>`,
      text: plainText,
    };
  }

  if (block.type === "callout") {
    const children = await renderChildBlocks(block, context);
    return {
      html: `<aside class="blog-callout"><p>${renderRichText(richText)}</p>${children.html}</aside>`,
      text: compactText([plainText, children.text].filter(Boolean).join("\n")),
    };
  }

  if (block.type === "to_do") {
    const checked = payload.checked ? " checked" : "";
    return {
      html: `<p class="blog-task"><input type="checkbox" disabled${checked}> <span>${renderRichText(richText)}</span></p>`,
      text: plainText,
    };
  }

  if (block.type === "code") {
    const language = payload.language
      ? ` class="language-${escapeAttribute(payload.language)}"`
      : "";
    return {
      html: `<pre><code${language}>${escapeHtml(plainText)}</code></pre>`,
      text: plainText,
    };
  }

  if (block.type === "image" || block.type === "file") {
    return renderFileBlock(
      block,
      context,
      block.type === "image" ? "content_image" : "file",
    );
  }

  if (block.type === "divider") {
    return { html: "<hr>", text: "" };
  }

  if (block.type === "bookmark" && payload.url) {
    const title = plainText || payload.url;
    return {
      html: `<p><a href="${escapeAttribute(payload.url)}" rel="nofollow noopener noreferrer">${escapeHtml(title)}</a></p>`,
      text: title,
    };
  }

  if (block.type === "table") {
    return renderTable(block);
  }

  if (block.type === "toggle") {
    const children = await renderChildBlocks(block, context);
    return {
      html: `<details><summary>${renderRichText(richText)}</summary>${children.html}</details>`,
      text: compactText([plainText, children.text].filter(Boolean).join("\n")),
    };
  }

  if (block.has_children) {
    const children = await renderChildBlocks(block, context);
    return { html: children.html, text: children.text };
  }

  return { html: "", text: "" };
}

type TablePayload = {
  has_column_header?: boolean;
  has_row_header?: boolean;
};

type TableRowPayload = { cells?: NotionRichText[][] };

/**
 * A Notion table is a `table` block whose children are `table_row` blocks, each
 * holding one rich-text array per cell. The wrapper lets a wide table scroll
 * sideways on a narrow screen instead of widening the article.
 */
async function renderTable(block: NotionBlock) {
  const table = (block.table ?? {}) as TablePayload;
  const rows = (block.has_children ? await listBlockChildren(block.id) : [])
    .filter((row) => row.type === "table_row")
    .map((row) => ((row.table_row ?? {}) as TableRowPayload).cells ?? []);
  if (rows.length === 0) {
    return { html: "", text: "" };
  }

  const renderRow = (cells: NotionRichText[][], header: boolean) =>
    `<tr>${cells
      .map((cell, column) => {
        const content = renderRichText(cell);
        if (header) {
          return `<th scope="col">${content}</th>`;
        }
        return table.has_row_header && column === 0
          ? `<th scope="row">${content}</th>`
          : `<td>${content}</td>`;
      })
      .join("")}</tr>`;

  const [first, ...rest] = rows;
  const headRows = table.has_column_header && first ? [first] : [];
  const bodyRows = table.has_column_header ? rest : rows;
  const head =
    headRows.length > 0
      ? `<thead>${headRows.map((cells) => renderRow(cells, true)).join("")}</thead>`
      : "";
  const body =
    bodyRows.length > 0
      ? `<tbody>${bodyRows.map((cells) => renderRow(cells, false)).join("")}</tbody>`
      : "";

  return {
    html: `<div class="blog-table"><table>${head}${body}</table></div>`,
    text: compactText(
      rows
        .map((cells) =>
          cells
            .map((cell) => richTextToPlainText(cell).trim())
            .filter(Boolean)
            .join(" | "),
        )
        .filter(Boolean)
        .join("\n"),
    ),
  };
}

async function renderListItem(block: NotionBlock, context: RenderContext) {
  const payload = getPayload(block);
  const richText = payload.rich_text ?? [];
  const plainText = richTextToPlainText(richText).trim();
  const children = await renderChildBlocks(block, context);

  return {
    html: `<li>${renderRichText(richText)}${children.html}</li>`,
    text: compactText([plainText, children.text].filter(Boolean).join("\n")),
  };
}

async function renderChildBlocks(block: NotionBlock, context: RenderContext) {
  if (!block.has_children) {
    return { html: "", text: "" };
  }

  const children = await listBlockChildren(block.id);
  const rendered = await renderBlocks(children, context);
  return {
    html: rendered.htmlParts.join("\n"),
    text: compactText(rendered.textParts.join("\n")),
  };
}

async function renderFileBlock(
  block: NotionBlock,
  context: RenderContext,
  assetKind: BlogAssetKind,
) {
  const payload = getPayload(block);
  const sourceUrl =
    payload.type === "external" ? payload.external?.url : payload.file?.url;
  if (!sourceUrl) {
    return { html: "", text: "" };
  }

  const caption = richTextToPlainText(payload.caption).trim();
  const fallbackName = assetKind === "content_image" ? "image" : "file";
  // An uncaptioned image would otherwise ship alt="", which reads as decorative.
  const imageAltText = caption || context.postTitle;

  if (context.dryRun) {
    return {
      html:
        assetKind === "content_image"
          ? `<figure><img src="${escapeAttribute(sourceUrl)}" alt="${escapeAttribute(imageAltText)}"></figure>`
          : `<p><a href="${escapeAttribute(sourceUrl)}">${escapeHtml(caption || fallbackName)}</a></p>`,
      text: caption,
    };
  }

  const uploaded = await downloadAndUploadBlogAsset({
    articleId: context.articleId,
    locale: context.locale,
    sourceUrl,
    fallbackFileName: fallbackName,
    contentTypeHint: null,
  });
  const assetId = buildBlogAssetId({
    postId: context.postId,
    kind: assetKind,
    sha256: uploaded.sha256,
  });

  await upsertBlogAsset({
    id: assetId,
    postId: context.postId,
    assetKind,
    asset: uploaded,
    altText: caption || context.postTitle,
  });
  context.assetIds.push(assetId);

  if (assetKind === "content_image") {
    return {
      html: `<figure><img src="${escapeAttribute(uploaded.publicUrl)}" alt="${escapeAttribute(imageAltText)}">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`,
      text: caption,
    };
  }

  return {
    html: `<p><a href="${escapeAttribute(uploaded.publicUrl)}">${escapeHtml(caption || fallbackName)}</a></p>`,
    text: caption,
  };
}

function getPayload(block: NotionBlock) {
  return (block[block.type] ?? {}) as RichTextPayload;
}

function renderRichText(richText: NotionRichText[]) {
  return richText
    .map((segment) => {
      const annotations = segment.annotations ?? {};
      let html = escapeHtml(segment.plain_text ?? "");

      if (annotations.code) {
        html = `<code>${html}</code>`;
      }
      if (annotations.bold) {
        html = `<strong>${html}</strong>`;
      }
      if (annotations.italic) {
        html = `<em>${html}</em>`;
      }
      if (annotations.underline) {
        html = `<u>${html}</u>`;
      }
      if (annotations.strikethrough) {
        html = `<s>${html}</s>`;
      }
      if (segment.href) {
        html = `<a href="${escapeAttribute(segment.href)}" rel="nofollow noopener noreferrer">${html}</a>`;
      }

      return html;
    })
    .join("");
}
