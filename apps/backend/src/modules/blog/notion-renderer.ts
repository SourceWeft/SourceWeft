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
  dryRun: boolean;
}) {
  const blocks = await listBlockChildren(input.pageId);
  const context: RenderContext = {
    articleId: input.articleId,
    locale: input.locale,
    postId: input.postId,
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

  if (context.dryRun) {
    return {
      html:
        assetKind === "content_image"
          ? `<figure><img src="${escapeAttribute(sourceUrl)}" alt="${escapeAttribute(caption)}"></figure>`
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
    altText: caption || null,
  });
  context.assetIds.push(assetId);

  if (assetKind === "content_image") {
    return {
      html: `<figure><img src="${escapeAttribute(uploaded.publicUrl)}" alt="${escapeAttribute(caption)}">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`,
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function compactText(value: string) {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function slugifyHeading(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function estimateReadingTime(text: string) {
  const cjkCharacters =
    text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)
      ?.length ?? 0;
  const words = text
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const readingUnits = words + cjkCharacters / 2;

  return Math.max(1, Math.ceil(readingUnits / 225));
}
