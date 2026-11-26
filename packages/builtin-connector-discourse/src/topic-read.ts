import {
  isNotFound,
  type DiscourseClient,
  type DiscourseNotFound,
} from "./client";
import { POST_BATCH } from "./limits";
import {
  isVisiblePost,
  type DiscoursePost,
  type DiscourseTopic,
} from "./model";

/** The posts read from one topic, the same way for a scan and an extract. */
export type TopicRead = {
  /** The visible posts that were read, ordered by (post number, id). */
  visible: DiscoursePost[];
  /** Posts of the topic's `stream` that the per-topic cap cut off. */
  omittedPosts: number;
};

function comparePosts(a: DiscoursePost, b: DiscoursePost): number {
  return a.postNumber - b.postNumber || a.id - b.id;
}

/**
 * Reads the first `maxPosts` posts of a topic whose document was just read:
 * the document carries the first page, the rest comes in batches of
 * POST_BATCH post ids. The scan's `deep` hash and the extract's text are both
 * built from this one read, so an unchanged topic hashes identically in both.
 *
 * Every request goes through `request`, so the caller keeps its own deadline,
 * request cap and error mapping. A batch that answers not-found is returned
 * as {@link DiscourseNotFound}: the caller decides what an inconsistent read
 * means.
 *
 * Posts the document carries that are not in `stream`, and ids the forum did
 * not return, are simply not read; `omittedPosts` counts only what the cap cut
 * off.
 */
export async function readTopicPosts(input: {
  client: DiscourseClient;
  topic: DiscourseTopic;
  maxPosts: number;
  request: <T>(call: () => Promise<T>) => Promise<T>;
}): Promise<TopicRead | DiscourseNotFound> {
  const { client, topic, maxPosts, request } = input;
  const included = topic.stream.slice(0, maxPosts);
  const wanted = new Set(included);
  const read = new Map<number, DiscoursePost>();
  for (const post of topic.posts) {
    if (wanted.has(post.id)) read.set(post.id, post);
  }
  const missing = included.filter((postId) => !read.has(postId));
  for (let start = 0; start < missing.length; start += POST_BATCH) {
    const batch = missing.slice(start, start + POST_BATCH);
    const reply = await request(() => client.topicPosts(topic.id, batch));
    if (isNotFound(reply)) return reply;
    for (const post of reply) {
      if (wanted.has(post.id)) read.set(post.id, post);
    }
  }
  const visible = [...read.values()].filter(isVisiblePost);
  visible.sort(comparePosts);
  return { visible, omittedPosts: topic.stream.length - included.length };
}
