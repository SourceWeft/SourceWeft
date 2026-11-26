import { postUrl, topicUrl } from "./forum-url";
import { MAX_TEXT_CHARS } from "./limits";
import {
  capText,
  isVisiblePost,
  lineOf,
  tagsOf,
  titleOf,
  type DiscoursePost,
  type DiscourseTopic,
} from "./model";
import { postHtmlToText } from "./post-text";

export type RenderTopicInput = {
  /** A validated forum base (see `parseForumUrl`). */
  base: string;
  /** The topic with the posts to include, in post order. */
  topic: DiscourseTopic;
  categoryPath: string;
  /** Visible posts that were not read and are therefore not in `topic`. */
  omittedPosts: number;
};

const TRUNCATION_MARKER = "[Content truncated]";
const FIELD_MAX = 2_000;
const AUTHOR_MAX = 200;

/**
 * A line of post text that would read as a topic title or a post section
 * once the post is part of the whole document.
 */
const FORGEABLE_LINE = /^\s*(?:## Post #|#(?:\s|$))/;

function postBody(post: DiscoursePost): string {
  const text = capText(postHtmlToText(post.cooked), MAX_TEXT_CHARS);
  return text
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((line) => (FORGEABLE_LINE.test(line) ? `  ${line}` : line))
    .join("\n");
}

function postSection(input: RenderTopicInput, post: DiscoursePost): string {
  const author =
    lineOf(post.username, AUTHOR_MAX) ??
    lineOf(post.name, AUTHOR_MAX) ??
    "unknown";
  const created = lineOf(post.createdAt, FIELD_MAX);
  const updated = lineOf(post.updatedAt, FIELD_MAX);
  let heading = `## Post #${post.postNumber} by ${author}`;
  if (created !== null) heading += ` · ${created}`;
  if (updated !== null && updated !== created)
    heading += ` (edited ${updated})`;

  const links = [
    `Link: ${postUrl(input.base, input.topic.slug, input.topic.id, post.postNumber)}`,
  ];
  if (post.replyToPostNumber !== null) {
    links.push(`Reply to #${post.replyToPostNumber}`);
  }
  const body = postBody(post);
  return [heading, links.join("\n"), ...(body === "" ? [] : [body])].join(
    "\n\n",
  );
}

function metadataList(input: RenderTopicInput): string {
  const { topic } = input;
  const rows: string[] = [];
  const category = lineOf(input.categoryPath, FIELD_MAX);
  if (category !== null) rows.push(`- Category: ${category}`);
  const tags = tagsOf(topic);
  if (tags.length > 0) rows.push(`- Tags: ${tags.join(", ")}`);
  const created = lineOf(topic.createdAt, FIELD_MAX);
  if (created !== null) rows.push(`- Created: ${created}`);
  const last = lineOf(topic.lastPostedAt, FIELD_MAX);
  if (last !== null) rows.push(`- Last post: ${last}`);
  const status = [
    topic.closed ? "closed" : null,
    topic.archived ? "archived" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  if (status !== "") rows.push(`- Status: ${status}`);
  rows.push(`- Posts: ${topic.postsCount}`);
  rows.push(`- URL: ${topicUrl(input.base, topic.slug, topic.id)}`);
  return rows.join("\n");
}

/**
 * Renders one topic as Markdown for indexing: its title, a metadata list and
 * one section per visible post. Every link is built here from the validated
 * base, the topic id and the post number; nothing from the forum's response
 * is used as a URL. Titles, authors, dates and the category path are single
 * lines, and a post's own lines can never form a title or a post section.
 * The result, including the final `[Content truncated]` line, fits in
 * MAX_TEXT_CHARS.
 */
export function renderTopicMarkdown(input: RenderTopicInput): string {
  const { topic } = input;
  const sections: string[] = [`# ${titleOf(topic)}`, metadataList(input)];
  let size = (sections[0]?.length ?? 0) + (sections[1]?.length ?? 0) + 2;

  for (const post of topic.posts) {
    if (size > MAX_TEXT_CHARS) break;
    if (!isVisiblePost(post)) continue;
    const section = postSection(input, post);
    sections.push(section);
    size += section.length + 2;
  }
  if (input.omittedPosts > 0 && size <= MAX_TEXT_CHARS) {
    sections.push(`[${input.omittedPosts} more posts not indexed]`);
  }

  const markdown = sections.join("\n\n");
  if (markdown.length <= MAX_TEXT_CHARS) return markdown;
  const marker = `\n\n${TRUNCATION_MARKER}`;
  return capText(markdown, MAX_TEXT_CHARS - marker.length) + marker;
}
