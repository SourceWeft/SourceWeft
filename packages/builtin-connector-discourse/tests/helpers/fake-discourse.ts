/**
 * An in-process fake of the public Discourse JSON API, exposed as a `fetch`.
 * There are no sockets: the fake is a function over `(url, init)` that records
 * every request and answers from a {@link FakeForum}. It follows what a real
 * Discourse answers:
 *
 * - `site.json`: `{ categories: [flat, with parent_category_id and
 *   read_restricted], default_archetype: "regular", ... }`;
 * - `c/<id>.json?page=N` (0-based): `{ topic_list: { topics: [30 per page],
 *   more_topics_url? } }`, `more_topics_url` absent on the last page;
 * - `t/<id>.json`: topic fields plus `post_stream: { posts: [first 20],
 *   stream: [all post ids] }`;
 * - `t/<id>/posts.json?post_ids[]=a&post_ids[]=b`: `{ post_stream: { posts } }`;
 * - `search.json?q=..&page=N` (1-based): `{ topics, posts, grouped_search_result }`;
 * - a login-required forum answers 403 everywhere;
 * - a 429 (injected with {@link FakeDiscourse.failNext}) carries `Retry-After`
 *   and a JSON body `{ extras: { wait_seconds } }`.
 *
 * Faults and header mutations are injected per request.
 */

export type FakePost = {
  id: number;
  post_number: number;
  username: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  version?: number;
  reply_to_post_number?: number | null;
  cooked: string;
  post_type?: number;
  hidden?: boolean;
  deleted_at?: string | null;
  user_deleted?: boolean;
};

export type FakeTopic = {
  id: number;
  title: string;
  slug: string;
  category_id: number;
  tags?: string[];
  created_at?: string;
  last_posted_at?: string;
  bumped_at?: string;
  closed?: boolean;
  archived?: boolean;
  visible?: boolean;
  /** Answer 410 (deleted topic) for the topic and its posts. */
  gone?: boolean;
  posts: FakePost[];
};

export type FakeCategory = {
  id: number;
  name: string;
  slug: string;
  parent_category_id?: number | null;
  read_restricted?: boolean;
  topic_count?: number;
};

export type FakeForum = {
  /** Subfolder the forum is served under, e.g. `/forum`; default none. */
  basePath?: string;
  categories: FakeCategory[];
  topics: FakeTopic[];
  /** Every request answers 403, like a forum that requires login. */
  loginRequired?: boolean;
};

export type RecordedRequest = {
  method: string;
  /** Path without the query, e.g. `/forum/site.json`. */
  path: string;
  /** Decoded query parameters (the last value of a repeated name wins). */
  query: Record<string, string>;
  /** Every decoded value of every query parameter. */
  queryAll: Record<string, string[]>;
  /** Lower-cased request header names. */
  headers: Record<string, string>;
  url: string;
  /** The RequestInit keys the caller passed. */
  initKeys: string[];
};

export type FakeFault =
  | {
      /** Answer with this status instead of serving the request. */
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  | { networkError: true }
  /** Never answer; rejects with an AbortError when the request's signal aborts. */
  | { hang: true };

export type FakeDiscourse = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  setForum(forum: FakeForum): void;
  /** The next `times` requests (optionally only those matching) get `fault`. */
  failNext(
    fault: FakeFault,
    times?: number,
    match?: (request: RecordedRequest) => boolean,
  ): void;
  /** Set (string) or remove (null) response headers on the next `times` served responses. */
  mutateNext(headers: Record<string, string | null>, times?: number): void;
};

/** Topics per category page, as a real Discourse. */
export const FAKE_PAGE_SIZE = 30;
/** Posts a topic document carries in `post_stream.posts`. */
export const FAKE_TOPIC_POSTS = 20;
const SEARCH_PAGE_SIZE = 50;

const DATE = "2026-01-01T00:00:00.000Z";

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function post(topic: FakeTopic, p: FakePost): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name ?? null,
    username: p.username,
    created_at: p.created_at ?? DATE,
    updated_at: p.updated_at ?? p.created_at ?? DATE,
    cooked: p.cooked,
    post_number: p.post_number,
    post_type: p.post_type ?? 1,
    reply_to_post_number: p.reply_to_post_number ?? null,
    version: p.version ?? 1,
    hidden: p.hidden ?? false,
    deleted_at: p.deleted_at ?? null,
    user_deleted: p.user_deleted ?? false,
    topic_id: topic.id,
  };
}

function topicRow(topic: FakeTopic): Record<string, unknown> {
  const highest = topic.posts.reduce((n, p) => Math.max(n, p.post_number), 0);
  return {
    id: topic.id,
    title: topic.title,
    fancy_title: topic.title,
    slug: topic.slug,
    posts_count: topic.posts.length,
    highest_post_number: highest,
    created_at: topic.created_at ?? DATE,
    last_posted_at: topic.last_posted_at ?? topic.created_at ?? DATE,
    bumped_at:
      topic.bumped_at ?? topic.last_posted_at ?? topic.created_at ?? DATE,
    archetype: "regular",
    visible: topic.visible ?? true,
    closed: topic.closed ?? false,
    archived: topic.archived ?? false,
    category_id: topic.category_id,
    tags: topic.tags ?? [],
  };
}

export function startFakeDiscourse(initial: FakeForum): FakeDiscourse {
  let forum: FakeForum = { ...initial };
  const requests: RecordedRequest[] = [];
  const faults: {
    fault: FakeFault;
    left: number;
    match?: (request: RecordedRequest) => boolean;
  }[] = [];
  const mutations: { headers: Record<string, string | null>; left: number }[] =
    [];

  function serve(request: RecordedRequest): Response {
    if (request.method !== "GET") return json({}, 405);
    const prefix = forum.basePath ?? "";
    if (!request.path.startsWith(`${prefix}/`)) return json({}, 404);
    if (forum.loginRequired) {
      return json(
        {
          errors: ["You need to be logged in to do that."],
          error_type: "not_logged_in",
        },
        403,
      );
    }
    const rest = request.path.slice(prefix.length + 1);

    if (rest === "site.json") {
      return json({
        default_archetype: "regular",
        notification_types: {},
        post_types: { regular: 1 },
        categories: forum.categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          color: "0088CC",
          topic_count: c.topic_count ?? 0,
          read_restricted: c.read_restricted ?? false,
          parent_category_id: c.parent_category_id ?? null,
        })),
      });
    }

    const category = /^c\/([1-9][0-9]*)\.json$/.exec(rest);
    if (category) {
      const id = Number(category[1]);
      if (!forum.categories.some((c) => c.id === id)) return json({}, 404);
      const all = forum.topics.filter((t) => t.category_id === id && !t.gone);
      const page = Number(request.query.page ?? "0");
      const slice = all.slice(
        page * FAKE_PAGE_SIZE,
        (page + 1) * FAKE_PAGE_SIZE,
      );
      const more = (page + 1) * FAKE_PAGE_SIZE < all.length;
      return json({
        users: [],
        topic_list: {
          can_create_topic: false,
          per_page: FAKE_PAGE_SIZE,
          topics: slice.map(topicRow),
          ...(more
            ? { more_topics_url: `/c/${id}/${id}/l/latest?page=${page + 1}` }
            : {}),
        },
      });
    }

    const topicPosts = /^t\/([1-9][0-9]*)\/posts\.json$/.exec(rest);
    if (topicPosts) {
      const topic = forum.topics.find((t) => t.id === Number(topicPosts[1]));
      if (!topic) return json({}, 404);
      if (topic.gone) return json({}, 410);
      const wanted = new Set(
        (request.queryAll["post_ids[]"] ?? []).map((v) => Number(v)),
      );
      const posts = topic.posts
        .filter((p) => wanted.has(p.id))
        .map((p) => post(topic, p));
      return json({ post_stream: { posts } });
    }

    const topicDoc = /^t\/([1-9][0-9]*)\.json$/.exec(rest);
    if (topicDoc) {
      const topic = forum.topics.find((t) => t.id === Number(topicDoc[1]));
      if (!topic) return json({}, 404);
      if (topic.gone) return json({}, 410);
      return json({
        ...topicRow(topic),
        post_stream: {
          posts: topic.posts
            .slice(0, FAKE_TOPIC_POSTS)
            .map((p) => post(topic, p)),
          stream: topic.posts.map((p) => p.id),
        },
      });
    }

    if (rest === "search.json") {
      const q = (request.query.q ?? "").toLowerCase();
      const page = Number(request.query.page ?? "1");
      const topics = forum.topics.filter(
        (t) =>
          !t.gone &&
          q !== "" &&
          (t.title.toLowerCase().includes(q) ||
            t.posts.some((p) => p.cooked.toLowerCase().includes(q))),
      );
      const posts = topics.flatMap((t) =>
        t.posts
          .filter((p) => p.cooked.toLowerCase().includes(q))
          .map((p) => ({
            id: p.id,
            name: p.name ?? null,
            username: p.username,
            created_at: p.created_at ?? DATE,
            post_number: p.post_number,
            blurb: p.cooked.replace(/<[^>]*>/g, "").slice(0, 200),
            topic_id: t.id,
          })),
      );
      const start = (page - 1) * SEARCH_PAGE_SIZE;
      const pageTopics = topics.slice(start, start + SEARCH_PAGE_SIZE);
      const body: Record<string, unknown> = {
        grouped_search_result: {
          more_posts: null,
          more_users: null,
          more_categories: null,
          term: request.query.q ?? "",
          more_full_page_results: start + SEARCH_PAGE_SIZE < topics.length,
        },
      };
      if (pageTopics.length > 0) {
        body.topics = pageTopics.map(topicRow);
        body.posts = posts.slice(start, start + SEARCH_PAGE_SIZE);
      }
      return json(body);
    }

    return json({}, 404);
  }

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const query: Record<string, string> = {};
    const queryAll: Record<string, string[]> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
      (queryAll[name] ??= []).push(value);
    });
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query,
      queryAll,
      headers,
      url: url.toString(),
      initKeys: init ? Object.keys(init) : [],
    };
    requests.push(request);

    const index = faults.findIndex((f) => !f.match || f.match(request));
    const pending = index === -1 ? undefined : faults[index];
    if (pending) {
      pending.left -= 1;
      if (pending.left <= 0) faults.splice(index, 1);
      const { fault } = pending;
      if ("networkError" in fault) throw new TypeError("fetch failed");
      if ("hang" in fault) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      const bodyless = [101, 204, 205, 304].includes(fault.status);
      return new Response(bodyless ? null : (fault.body ?? ""), {
        status: fault.status,
        headers: fault.headers,
      });
    }

    const response = serve(request);
    const mutation = mutations[0];
    if (!mutation) return response;
    mutation.left -= 1;
    if (mutation.left <= 0) mutations.shift();
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(mutation.headers)) {
      if (value === null) merged.delete(name);
      else merged.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: merged,
    });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    setForum(next) {
      forum = { ...next };
    },
    failNext(fault, times = 1, match) {
      faults.push({ fault, left: times, match });
    },
    mutateNext(headers, times = 1) {
      mutations.push({ headers, left: times });
    },
  };
}

/** A forum with `count` topics in category 10 and a parent/child category pair. */
export function sampleForum(
  options: { topics?: number; basePath?: string } = {},
): FakeForum {
  const count = options.topics ?? 3;
  const topics: FakeTopic[] = [];
  for (let i = 1; i <= count; i += 1) {
    topics.push({
      id: i,
      title: `Topic ${i}`,
      slug: `topic-${i}`,
      category_id: 10,
      tags: i % 2 === 0 ? ["even"] : [],
      posts: [
        {
          id: i * 1000 + 1,
          post_number: 1,
          username: "alice",
          cooked: `<p>Hello from topic ${i}</p>`,
        },
        {
          id: i * 1000 + 2,
          post_number: 2,
          username: "bob",
          cooked: "<p>A reply</p>",
          reply_to_post_number: 1,
        },
      ],
    });
  }
  return {
    basePath: options.basePath,
    categories: [
      { id: 10, name: "General", slug: "general", topic_count: count },
      {
        id: 11,
        name: "Support",
        slug: "support",
        parent_category_id: 10,
      },
      { id: 12, name: "Staff", slug: "staff", read_restricted: true },
    ],
    topics,
  };
}
