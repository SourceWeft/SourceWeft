import {
  ConnectorItemSkipError,
  type ConnectorExtractedText,
  type ConnectorItem,
} from "@sourceweft/contracts";
import { isNotFound, type DiscourseClient } from "./client";
import { DiscourseError } from "./errors";
import { MAX_POSTS_PER_TOPIC } from "./limits";
import { deepHashOf, titleOf, type RefreshMode } from "./model";
import { renderTopicMarkdown } from "./render";
import { readTopicPosts } from "./topic-read";

export type ExtractDiscourseTopicInput = {
  client: DiscourseClient;
  /** A validated forum base (see `parseForumUrl`). */
  base: string;
  item: ConnectorItem;
  /** The refresh mode the forum was scanned with. */
  refresh: RefreshMode;
  /** Test seam: the per-topic post cap; defaults to the package limit. */
  limits?: { MAX_POSTS_PER_TOPIC: number };
};

function skip(): ConnectorItemSkipError {
  return new ConnectorItemSkipError("unreadable");
}

/**
 * Re-reads one topic (its document and the posts the document does not
 * carry, the same way the `deep` scan reads it) and renders it as Markdown.
 *
 * In `light` mode the returned `contentHash` is the discovery hash unchanged:
 * a topic that grew since the scan renders the newer text and the next scan
 * sees the change. In `deep` mode it is recomputed over exactly the posts
 * rendered, with the function the scan uses, so an unchanged topic hashes
 * identically in both. A topic that is deleted, restricted or too large since
 * the scan is skipped; the next scan reconciles it.
 */
export async function extractDiscourseTopic(
  input: ExtractDiscourseTopicInput,
): Promise<ConnectorExtractedText> {
  const { client, base, item, refresh } = input;
  const { topicId, categoryPath } = item.metadata;
  // Checked before any request. Corrupt metadata on one item skips that item;
  // it must not abort the whole run.
  if (
    typeof topicId !== "number" ||
    !Number.isSafeInteger(topicId) ||
    topicId <= 0 ||
    typeof categoryPath !== "string"
  ) {
    throw skip();
  }
  const maxPosts = input.limits?.MAX_POSTS_PER_TOPIC ?? MAX_POSTS_PER_TOPIC;

  try {
    const doc = await client.topic(topicId);
    if (isNotFound(doc)) throw skip();
    const read = await readTopicPosts({
      client,
      topic: doc,
      maxPosts,
      request: (call) => call(),
    });
    // Posts that turn not-found after the topic was read: the topic changed
    // under the read, and the next scan reconciles it.
    if (isNotFound(read)) throw skip();

    const markdown = renderTopicMarkdown({
      base,
      topic: { ...doc, posts: read.visible },
      categoryPath,
      omittedPosts: read.omittedPosts,
    });
    return {
      item: {
        ...item,
        title: titleOf(doc),
        contentHash:
          refresh === "deep" ? deepHashOf(doc, read.visible) : item.contentHash,
      },
      contentText: markdown,
      markdown,
    };
  } catch (error) {
    if (
      error instanceof DiscourseError &&
      error.code === "DISCOURSE_TOO_LARGE"
    ) {
      throw skip();
    }
    throw error;
  }
}
