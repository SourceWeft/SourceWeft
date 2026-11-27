import {
  HTML_TO_MARKDOWN_MAX_INPUT_CHARS,
  htmlToMarkdown,
} from "@sourceweft/html-text";
import { WordPressError } from "./errors";
import { MAX_METADATA_TERMS, MAX_TEXT_CHARS } from "./limits";
import {
  capText,
  isoOf,
  lineOf,
  termNames,
  titleOf,
  validateLink,
  type WpNames,
  type WpPost,
} from "./model";

const TRUNCATION_MARKER = "[Content truncated]";
const FIELD_MAX = 2_000;
const TERM_LIST_MAX = 10_000;

/** The smallest cap that still holds a heading and the truncation line. */
const MIN_MAX_CHARS = 100;

/**
 * A value as one line of inline Markdown that cannot start a block or form a
 * link, image or autolink: whitespace is collapsed (so it cannot begin a
 * heading, rule or list), and a backslash, `[`, `]`, `<` and `>` are escaped
 * (the backslash first, so an escape cannot be undone).
 */
function inline(value: string | null, max: number): string | null {
  const flat = lineOf(value, max);
  return flat === null ? null : flat.replace(/[\\[\]<>]/g, "\\$&");
}

function metadataRows(
  post: WpPost,
  names: WpNames,
  authorName: string | null,
  url: string,
): string[] {
  const rows = [`- Type: ${post.type === "page" ? "Page" : "Post"}`];
  const categories = termNames(post.categoryIds, names.categories)
    .slice(0, MAX_METADATA_TERMS)
    .map((name) => inline(name, FIELD_MAX))
    .filter((name): name is string => name !== null);
  if (categories.length > 0) {
    rows.push(`- Categories: ${capText(categories.join(", "), TERM_LIST_MAX)}`);
  }
  const tags = termNames(post.tagIds, names.tags)
    .slice(0, MAX_METADATA_TERMS)
    .map((name) => inline(name, FIELD_MAX))
    .filter((name): name is string => name !== null);
  if (tags.length > 0) {
    rows.push(`- Tags: ${capText(tags.join(", "), TERM_LIST_MAX)}`);
  }
  const author = inline(authorName, FIELD_MAX);
  if (author !== null) rows.push(`- Author: ${author}`);
  const published = isoOf(post.publishedGmt);
  if (published !== null) rows.push(`- Published: ${published}`);
  const modified = isoOf(post.modifiedGmt);
  if (modified !== null) rows.push(`- Modified: ${modified}`);
  if (post.status !== "publish") {
    rows.push(`- Status: ${inline(post.status, FIELD_MAX) ?? "unknown"}`);
  }
  rows.push(`- URL: ${url}`);
  return rows;
}

/** Cuts `text` to at most `max` characters on a line boundary after `keep`
 * characters (so the heading and metadata are kept and some body with them),
 * else hard, as a single huge line has no boundary. */
function cut(text: string, max: number, keep: number): string {
  const head = capText(text, max);
  const boundary =
    text.charCodeAt(head.length) === 10 ? head.length : head.lastIndexOf("\n");
  if (boundary > keep) return head.slice(0, boundary).trimEnd();
  return head.trimEnd();
}

/**
 * Renders one post or page as Markdown for indexing: its title, a metadata
 * list and the body converted from the site's HTML. Titles, names, dates and
 * the URL are single lines and the link and bracket syntax in them is escaped,
 * so a hostile title or category cannot create a section or a link. The URL is
 * the validated `link` (`LINK_HOST_MISMATCH` otherwise). The result, including
 * the final `[Content truncated]` line, fits in `maxChars`. A password
 * protected post has no readable body and is never rendered: the caller skips
 * it, and this throws `BAD_RESPONSE` if it is asked to render one.
 */
export function renderContent(
  post: WpPost,
  names: WpNames,
  authorName: string | null,
  siteHost: string,
  maxChars: number = MAX_TEXT_CHARS,
): string {
  if (!(maxChars >= MIN_MAX_CHARS)) {
    throw new RangeError(`maxChars must be at least ${MIN_MAX_CHARS}`);
  }
  if (post.protected) throw new WordPressError("BAD_RESPONSE");
  const url = validateLink(post.link, siteHost);
  const header = [
    `# ${inline(titleOf(post), FIELD_MAX) ?? "Untitled"}`,
    "",
    ...metadataRows(post, names, authorName, url),
  ].join("\n");
  // The body is converted without a cap so a cut is known to have happened;
  // the converter's own input ceiling bounds the work.
  const body = htmlToMarkdown(post.contentHtml, {
    maxChars: Number.POSITIVE_INFINITY,
  });
  const full = body === "" ? header : `${header}\n\n${body}`;
  const marker = `\n\n${TRUNCATION_MARKER}`;
  // The converter ignores HTML past its input ceiling without saying so: that
  // is a truncation too, even when what it did read converts to a short text.
  const inputCut = post.contentHtml.length > HTML_TO_MARKDOWN_MAX_INPUT_CHARS;
  if (full.length + (inputCut ? marker.length : 0) <= maxChars) {
    return inputCut ? full + marker : full;
  }
  return cut(full, maxChars - marker.length, header.length + 2) + marker;
}
