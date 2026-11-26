import type {
  ConnectorDiscoveryPage,
  ConnectorItem,
} from "@sourceweft/contracts";
import { isNotFound, type DiscourseClient } from "./client";
import { DiscourseError } from "./errors";
import {
  MAX_POSTS_PER_TOPIC,
  MAX_REQUESTS,
  MAX_TOPICS,
  MAX_TOPICS_PER_CATEGORY,
  POST_BATCH,
  SCAN_TIMEOUT_MS,
} from "./limits";
import {
  buildCategoryTree,
  deepHashOf,
  isVisiblePost,
  lightHashOf,
  toConnectorItem,
  type DiscoursePost,
  type DiscourseTopic,
  type DiscourseTopicRow,
  type RefreshMode,
} from "./model";

/** The caps one scan enforces; each defaults to the matching package limit. */
export type ScanLimits = {
  /** Distinct topics one scan may index, across all selections. */
  MAX_TOPICS: number;
  /** Topic rows one category walk may read. */
  MAX_TOPICS_PER_CATEGORY: number;
  /** Requests the whole scan may make. */
  MAX_REQUESTS: number;
  /** Wall-clock budget of the whole scan. */
  SCAN_TIMEOUT_MS: number;
  /** Posts read (and hashed) per topic in `deep` mode. */
  MAX_POSTS_PER_TOPIC: number;
};

export type ScanSelection = Array<{
  id: number;
  kind: "category" | "topic";
}>;

export type ScanForumInput = {
  client: DiscourseClient;
  /** A validated forum base (see `parseForumUrl`). */
  base: string;
  selection: ScanSelection;
  refresh: RefreshMode;
  now?: () => number;
  limits?: Partial<ScanLimits>;
  /** Receives a fixed event name and a reason string only. */
  logger?: {
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
};

type IncompleteReason = "too_large" | "timeout";

/** Thrown inside a scan when it must give up without raising a platform error. */
class ScanIncomplete extends Error {
  constructor(readonly reason: IncompleteReason) {
    super(reason);
    this.name = "ScanIncomplete";
  }
}

const DEFAULTS: ScanLimits = {
  MAX_TOPICS,
  MAX_TOPICS_PER_CATEGORY,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  MAX_POSTS_PER_TOPIC,
};

function comparePosts(a: DiscoursePost, b: DiscoursePost): number {
  return a.postNumber - b.postNumber || a.id - b.id;
}

/**
 * Scans the selected categories and topics of a public Discourse forum and
 * yields exactly one final page.
 *
 * `light` indexes a topic from its listing row (one request per category page,
 * none per topic); `deep` reads every topic and the posts the topic document
 * does not carry. A complete scan reconciles (`reconcileMissing: true`), also
 * when a selected category or topic is gone or restricted: nothing of it is
 * listed, so its sources are archived. A scan that exceeds a cap or the
 * wall-clock budget yields an empty, non-reconciling page, so nothing is
 * archived on partial data. Every other failure (login wall, rate limit,
 * unreachable forum, unparseable response) propagates as a
 * {@link DiscourseError}: nothing is skipped and half-indexed.
 */
export async function* scanForum(
  input: ScanForumInput,
): AsyncGenerator<ConnectorDiscoveryPage> {
  if (input.selection.length === 0) {
    throw new DiscourseError("DISCOURSE_SELECTION_REQUIRED");
  }
  const now = input.now ?? Date.now;
  const limits: ScanLimits = { ...DEFAULTS, ...input.limits };
  const { client, base, refresh } = input;
  const deadline = now() + limits.SCAN_TIMEOUT_MS;
  let requests = 0;

  /**
   * Every request goes through here so the caps hold for the whole scan. The
   * real time bound is the deadline plus one client call (which has its own
   * per-request timeout and retries).
   */
  async function call<T>(request: () => Promise<T>): Promise<T> {
    if (now() >= deadline) throw new ScanIncomplete("timeout");
    if (requests >= limits.MAX_REQUESTS) throw new ScanIncomplete("too_large");
    requests += 1;
    try {
      return await request();
    } catch (error) {
      if (
        error instanceof DiscourseError &&
        error.code === "DISCOURSE_TOO_LARGE"
      ) {
        throw new ScanIncomplete("too_large");
      }
      throw error;
    }
  }

  async function scan(): Promise<ConnectorDiscoveryPage> {
    const tree = buildCategoryTree(
      (await call(() => client.site())).categories,
    );

    const known = new Map<number, boolean>();
    /** A category that is listed in `site.json` and not read-restricted. */
    const readable = (id: number): boolean => {
      let ok = known.get(id);
      if (ok === undefined) {
        ok = tree.expand([id]).size > 0 && !tree.isRestricted(id);
        known.set(id, ok);
      }
      return ok;
    };

    const selectedCategories = [
      ...new Set(
        input.selection.filter((s) => s.kind === "category").map((s) => s.id),
      ),
    ].sort((a, b) => a - b);
    const selectedTopics = [
      ...new Set(
        input.selection.filter((s) => s.kind === "topic").map((s) => s.id),
      ),
    ];

    // A category list already holds its subcategories' topics, so only the
    // top-most selected categories are walked. Of two categories that contain
    // each other (a cycle in the forum's data) the lower id is kept.
    const usable = selectedCategories.filter(readable);
    const roots = usable.filter(
      (id) =>
        !usable.some(
          (other) =>
            other !== id &&
            tree.expand([other]).has(id) &&
            !(tree.expand([id]).has(other) && other > id),
        ),
    );

    /** Topics that will be indexed, by id, from the listing or topic row. */
    const found = new Map<number, DiscourseTopicRow>();
    /** Topic documents already read (selected single topics). */
    const documents = new Map<number, DiscourseTopic>();

    /** A topic is indexed only in a known, public category and when visible. */
    const acceptable = (row: DiscourseTopicRow): boolean =>
      row.visible && row.categoryId !== null && readable(row.categoryId);

    function admit(row: DiscourseTopicRow): void {
      if (found.has(row.id) || !acceptable(row)) return;
      found.set(row.id, row);
      if (found.size > limits.MAX_TOPICS) throw new ScanIncomplete("too_large");
    }

    for (const root of roots) {
      const rows: DiscourseTopicRow[] = [];
      let gone = false;
      for (let page = 0; ; page += 1) {
        const result = await call(() => client.categoryPage(root, page));
        if (isNotFound(result)) {
          // Gone on the first page: nothing to list. Gone after rows were
          // read is an inconsistent read, never "the category is empty".
          if (page > 0) throw new DiscourseError("DISCOURSE_BAD_RESPONSE");
          gone = true;
          break;
        }
        rows.push(...result.topics);
        if (rows.length > limits.MAX_TOPICS_PER_CATEGORY) {
          throw new ScanIncomplete("too_large");
        }
        // The walk stops on a missing `more_topics_url` or an empty page; it
        // is only a presence signal, never followed. Real-forum behaviour is
        // confirmed in Task 9's read-shape check.
        if (!result.hasMore || result.topics.length === 0) break;
      }
      // A category that vanished or became restricted lists nothing.
      if (!gone) for (const row of rows) admit(row);
    }

    for (const id of selectedTopics) {
      if (found.has(id)) continue;
      const doc = await call(() => client.topic(id));
      if (isNotFound(doc)) continue;
      documents.set(id, doc);
      admit(doc);
    }

    const items: ConnectorItem[] = [];
    const pathOf = (row: DiscourseTopicRow): string =>
      row.categoryId === null ? "" : tree.pathOf(row.categoryId);

    for (const [id, row] of found) {
      if (refresh === "light") {
        items.push(
          toConnectorItem(row, {
            base,
            categoryPath: pathOf(row),
            refresh,
            hash: lightHashOf(row),
            postIds: [],
            authors: [],
          }),
        );
        continue;
      }

      let doc = documents.get(id);
      if (!doc) {
        const fetched = await call(() => client.topic(id));
        if (isNotFound(fetched)) continue;
        doc = fetched;
      }
      // The topic document is the fresher row: check it again.
      if (!acceptable(doc)) continue;

      // Read the first posts up to the cap: the document carries the first
      // page, the rest comes in batches of POST_BATCH post ids.
      const included = doc.stream.slice(0, limits.MAX_POSTS_PER_TOPIC);
      const wanted = new Set(included);
      const read = new Map<number, DiscoursePost>();
      for (const post of doc.posts) {
        if (wanted.has(post.id)) read.set(post.id, post);
      }
      const missing = included.filter((postId) => !read.has(postId));
      for (let start = 0; start < missing.length; start += POST_BATCH) {
        const batch = missing.slice(start, start + POST_BATCH);
        const reply = await call(() => client.topicPosts(id, batch));
        // The topic document was just read: posts that are suddenly
        // not found are an inconsistent read, never a deleted topic.
        if (isNotFound(reply))
          throw new DiscourseError("DISCOURSE_BAD_RESPONSE");
        for (const post of reply) {
          if (wanted.has(post.id)) read.set(post.id, post);
        }
      }

      // Posts the document carries that are not in `stream`, and ids the
      // forum did not return, are simply not read; `omittedPosts` counts only
      // what the per-topic cap cut off.
      // The hash, the post ids and the authors are over the same posts.
      const visible = [...read.values()].filter(isVisiblePost);
      visible.sort(comparePosts);
      items.push(
        toConnectorItem(doc, {
          base,
          categoryPath: pathOf(doc),
          refresh,
          hash: deepHashOf(doc, visible),
          postIds: visible.map((post) => post.id),
          authors: visible.flatMap((post) => {
            const author = post.username ?? post.name;
            return author === null ? [] : [author];
          }),
          omittedPosts: doc.stream.length - included.length,
        }),
      );
    }

    return {
      items,
      deletedExternalIds: [],
      complete: true,
      reconcileMissing: true,
      checkpoint: null,
    };
  }

  let page: ConnectorDiscoveryPage;
  try {
    page = await scan();
  } catch (error) {
    if (!(error instanceof ScanIncomplete)) throw error;
    input.logger?.warn?.("discourse_scan_incomplete", { reason: error.reason });
    page = {
      items: [],
      deletedExternalIds: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    };
  }
  yield page;
}
