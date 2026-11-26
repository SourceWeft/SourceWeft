import type { Locale } from "@sourceweft/i18n/locales";
import { addLocalePrefix } from "@sourceweft/i18n/resolve";

import type { BlogPostSummary } from "./blog-db";
import { escapeXml } from "./sitemap-xml";
import { SITE_URL } from "../app/seo";

export const BLOG_FEED_MAX_ITEMS = 50;
export const BLOG_FEED_CONTENT_TYPE = "application/rss+xml";

/** `/blog/feed.xml` for the default language, `/<locale>/blog/feed.xml` otherwise. */
export function blogFeedPath(locale: Locale) {
  return addLocalePrefix("/blog/feed.xml", locale);
}

export function blogFeedUrl(locale: Locale) {
  return `${SITE_URL}${blogFeedPath(locale)}`;
}

/** `alternates.types` entry that makes a page announce its language's feed. */
export function blogFeedAlternate(locale: Locale, title: string) {
  return {
    [BLOG_FEED_CONTENT_TYPE]: [{ title, url: blogFeedUrl(locale) }],
  };
}

// Code points XML 1.0 cannot carry, and lone surrogates. An article's title or
// excerpt is author text: one stray control character must cost that
// character, not the whole language's feed.
const INVALID_XML_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- these are the characters to remove
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu;

function xmlText(value: string) {
  return escapeXml(value.replace(INVALID_XML_CHARACTERS, ""));
}

function element(name: string, value: string) {
  return `<${name}>${xmlText(value)}</${name}>`;
}

function itemXml(post: BlogPostSummary) {
  const url = `${SITE_URL}${post.urlPath}`;
  const fields = [
    element("title", post.title),
    element("link", url),
    `<guid isPermaLink="true">${xmlText(url)}</guid>`,
    element("description", post.excerpt),
    ...(post.publishedAt
      ? [element("pubDate", post.publishedAt.toUTCString())]
      : []),
    ...post.tags.map((tag) => element("category", tag)),
  ];
  return `<item>${fields.join("")}</item>\n`;
}

/**
 * RSS 2.0 for one language. `posts` must already be that language's own
 * published articles with `urlPath` under the same locale; the newest
 * `BLOG_FEED_MAX_ITEMS` are listed, newest first.
 */
export function blogFeedXml(input: {
  locale: Locale;
  title: string;
  description: string;
  posts: BlogPostSummary[];
}) {
  const posts = [...input.posts]
    .sort(
      (left, right) =>
        (right.publishedAt?.getTime() ?? 0) -
          (left.publishedAt?.getTime() ?? 0) ||
        left.slug.localeCompare(right.slug),
    )
    .slice(0, BLOG_FEED_MAX_ITEMS);
  const lastChange = posts.reduce<number>(
    (latest, post) =>
      Math.max(
        latest,
        post.updatedAt?.getTime() ?? 0,
        post.publishedAt?.getTime() ?? 0,
      ),
    0,
  );
  const channel = [
    element("title", input.title),
    element("link", `${SITE_URL}${addLocalePrefix("/blog", input.locale)}`),
    element("description", input.description),
    element("language", input.locale),
    ...(lastChange
      ? [element("lastBuildDate", new Date(lastChange).toUTCString())]
      : []),
    `<atom:link href="${xmlText(blogFeedUrl(input.locale))}" rel="self" type="${BLOG_FEED_CONTENT_TYPE}"/>`,
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    `<channel>\n${channel.join("\n")}\n` +
    posts.map(itemXml).join("") +
    "</channel>\n</rss>"
  );
}
