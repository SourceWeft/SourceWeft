import {
  HTML_TO_MARKDOWN_MAX_INPUT_CHARS,
  htmlToMarkdown,
} from "@sourceweft/html-text";
import { GhostError } from "./errors";
import { MAX_METADATA_TERMS, MAX_TEXT_CHARS } from "./limits";
import { capText, isoOf, oneLine, titleOf, type GhostItem } from "./model";
import { validateCitationUrl } from "./site-url";

const TRUNCATION_MARKER = "[Content truncated]";
const FIELD_MAX = 2_000;
const URL_MAX = 2_048;
const TERM_LIST_MAX = 10_000;

/** The smallest cap that still holds a heading and the truncation line. */
const MIN_MAX_CHARS = 100;

/**
 * A value as one line of inline Markdown that cannot start a block or form a
 * link, image or autolink: whitespace is collapsed (so it cannot begin a
 * heading, rule or list), and a backslash, `[`, `]`, `<` and `>` are escaped
 * (the backslash first, so an escape cannot be undone).
 */
function inline(value: string, max: number): string | null {
  const flat = capText(oneLine(value), max);
  return flat === "" ? null : flat.replace(/[\\[\]<>]/g, "\\$&");
}

function names(values: string[]): string[] {
  return values
    .slice(0, MAX_METADATA_TERMS)
    .map((value) => inline(value, FIELD_MAX))
    .filter((value): value is string => value !== null);
}

function metadataRows(item: GhostItem, url: string): string[] {
  const rows = [`- Type: ${item.type === "page" ? "Page" : "Post"}`];
  const tags = names(item.tags.map((tag) => tag.name));
  if (tags.length > 0) {
    rows.push(`- Tags: ${capText(tags.join(", "), TERM_LIST_MAX)}`);
  }
  const authors = names(item.authors);
  if (authors.length > 0) {
    rows.push(`- Authors: ${capText(authors.join(", "), TERM_LIST_MAX)}`);
  }
  if (item.publishedAt !== null) {
    rows.push(`- Published: ${isoOf(item.publishedAt)}`);
  }
  rows.push(`- Updated: ${isoOf(item.updatedAt)}`);
  rows.push(`- URL: ${inline(url, URL_MAX) ?? url}`);
  const canonical =
    item.canonicalUrl === null ? null : inline(item.canonicalUrl, URL_MAX);
  if (canonical !== null) rows.push(`- Canonical URL: ${canonical}`);
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
 * links are single lines and the link and bracket syntax in them is escaped,
 * so a hostile title, tag or author cannot create a section or a link. The URL
 * is the validated citation `url` (`LINK_INVALID` otherwise). The result,
 * including the final `[Content truncated]` line, fits in `maxChars`. An item
 * the key cannot read in full (`access` false) has only a teaser: it is never
 * rendered, and this throws `BAD_RESPONSE` if asked to.
 */
export function renderContent(
  item: GhostItem,
  _siteHost: string,
  maxChars: number = MAX_TEXT_CHARS,
): string {
  if (!(maxChars >= MIN_MAX_CHARS)) {
    throw new RangeError(`maxChars must be at least ${MIN_MAX_CHARS}`);
  }
  if (!item.access) throw new GhostError("BAD_RESPONSE");
  const url = validateCitationUrl(item.url);
  const header = [
    `# ${inline(titleOf(item), FIELD_MAX) ?? "Untitled"}`,
    "",
    ...metadataRows(item, url),
  ].join("\n");
  // The body is converted without a cap so a cut is known to have happened;
  // the converter's own input ceiling bounds the work.
  const body = htmlToMarkdown(item.html, {
    maxChars: Number.POSITIVE_INFINITY,
  });
  const full = body === "" ? header : `${header}\n\n${body}`;
  const marker = `\n\n${TRUNCATION_MARKER}`;
  // The converter ignores HTML past its input ceiling without saying so: that
  // is a truncation too, even when what it did read converts to a short text.
  const inputCut = item.html.length > HTML_TO_MARKDOWN_MAX_INPUT_CHARS;
  if (full.length + (inputCut ? marker.length : 0) <= maxChars) {
    return inputCut ? full + marker : full;
  }
  return cut(full, maxChars - marker.length, header.length + 2) + marker;
}
