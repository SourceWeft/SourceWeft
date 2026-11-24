"use client";

import { useMemo } from "react";
import { defaultRehypePlugins, type Components } from "streamdown";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";

/**
 * Streamdown's default rehype chain without its `raw` step, so HTML written
 * in a message is never parsed into elements; `skipHtml` then drops it.
 * Sanitize and harden still run as they do everywhere else.
 */
const PUBLIC_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin);

/** Footnote references (`[^n]`) in the snapshot's message Markdown. */
const FOOTNOTE_REFERENCE = /\[\^(\d+)\]/g;

/**
 * Fenced blocks (closed or running to the end) and inline code spans — the
 * same grammar the backend uses when it writes the markers, so a `[^n]`
 * inside code stays literal.
 */
const CODE_PATTERN = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

/**
 * The snapshot keeps citation markers as `[^n]` but lists the footnotes
 * itself under the message (with link rules the Markdown renderer can't
 * apply), so GFM never sees their definitions and would print `[^1]`
 * verbatim. Show each one as a bracketed `[n]` that matches the numbered
 * source list instead, leaving code untouched.
 */
export function renderFootnoteReferences(content: string) {
  return content
    .split(CODE_PATTERN)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(FOOTNOTE_REFERENCE, "\\[$1\\]"),
    )
    .join("");
}

function normalizedUrl(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * A message's Markdown on the public shared-chat page: the app's chat
 * renderer with raw HTML off, and with images limited to the share's own
 * token-scoped image URLs so the page never contacts another host. Any
 * other image shows its alt text. Only this page uses these options; the
 * renderer's defaults elsewhere are unchanged.
 */
export function SharedChatMarkdown({
  allowedImageUrls,
  content,
}: {
  allowedImageUrls: string[];
  content: string;
}) {
  const allowedKey = allowedImageUrls.join("\n");
  const components = useMemo<Components>(() => {
    const allowed = new Set(
      allowedKey ? allowedKey.split("\n").map(normalizedUrl) : [],
    );
    return {
      img: ({ alt, src }) => {
        if (typeof src === "string" && allowed.has(normalizedUrl(src))) {
          return (
            // eslint-disable-next-line @next/next/no-img-element -- a signed, token-scoped public URL, as in the page's own image list.
            <img
              alt={alt ?? ""}
              className="my-4 max-w-full rounded-lg"
              data-streamdown="image"
              loading="lazy"
              src={src}
            />
          );
        }
        return alt ? <span>{alt}</span> : null;
      },
    };
  }, [allowedKey]);

  return (
    <MessageResponse
      components={components}
      rehypePlugins={PUBLIC_REHYPE_PLUGINS}
      skipHtml
    >
      {renderFootnoteReferences(content)}
    </MessageResponse>
  );
}
