import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  type ConnectorItem,
} from "@sourceweft/contracts";
import { createDiscourseClient } from "../src/client";
import { extractDiscourseTopic } from "../src/extract";
import { MAX_POSTS_PER_TOPIC, POST_BATCH } from "../src/limits";
import { scanForum } from "../src/scan";
import {
  FAKE_TOPIC_POSTS,
  startFakeDiscourse,
  type FakeForum,
  type FakePost,
  type FakeTopic,
} from "./helpers/fake-discourse";

const BASE = "https://forum.example.com";

function posts(topicId: number, count: number): FakePost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: topicId * 1000 + i + 1,
    post_number: i + 1,
    username: i % 2 === 0 ? "alice" : "bob",
    cooked: `<p>Post ${i + 1} of topic ${topicId}</p>`,
  }));
}

function topic(
  id: number,
  options: Partial<FakeTopic> & { postCount?: number } = {},
): FakeTopic {
  const { postCount, ...rest } = options;
  return {
    id,
    title: `Topic ${id}`,
    slug: `topic-${id}`,
    category_id: 11,
    posts: posts(id, postCount ?? 2),
    ...rest,
  };
}

function forum(topics: FakeTopic[]): FakeForum {
  return {
    categories: [
      { id: 10, name: "General", slug: "general" },
      { id: 11, name: "Support", slug: "support", parent_category_id: 10 },
    ],
    topics,
  };
}

function setup(
  initial: FakeForum,
  clientLimits?: Parameters<typeof createDiscourseClient>[0]["limits"],
) {
  const fake = startFakeDiscourse(initial);
  const client = createDiscourseClient({
    fetch: fake.fetch,
    base: BASE,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0, ...clientLimits },
  });
  return { fake, client };
}

async function scanItem(
  client: ReturnType<typeof setup>["client"],
  topicId: number,
  refresh: "light" | "deep",
  limits?: { MAX_POSTS_PER_TOPIC: number },
): Promise<ConnectorItem> {
  const items: ConnectorItem[] = [];
  for await (const page of scanForum({
    client,
    base: BASE,
    selection: [{ id: topicId, kind: "topic" }],
    refresh,
    now: () => 1_000,
    limits,
  })) {
    items.push(...page.items);
  }
  const [item] = items;
  assert.ok(item);
  return item;
}

const paths = (fake: { requests: { path: string }[] }) =>
  fake.requests.map((r) => r.path);

async function skipped(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectorItemSkipError);
    assert.equal(error.reason, "unreadable");
    return true;
  });
}

test("extract fetches the topic and one posts.json per batch of remaining ids", async () => {
  const count = FAKE_TOPIC_POSTS + 2 * POST_BATCH + 1;
  const { fake, client } = setup(forum([topic(1, { postCount: count })]));
  const item = await scanItem(client, 1, "light");
  fake.requests.length = 0;

  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "light",
  });

  assert.deepEqual(paths(fake), [
    "/t/1.json",
    "/t/1/posts.json",
    "/t/1/posts.json",
    "/t/1/posts.json",
  ]);
  for (const request of fake.requests.slice(1)) {
    assert.ok((request.queryAll["post_ids[]"] ?? []).length <= POST_BATCH);
  }
  assert.ok(result.markdown?.includes(`## Post #${count} by`));
  assert.equal(result.contentText, result.markdown);
});

test("a short topic costs one request", async () => {
  const { fake, client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  fake.requests.length = 0;
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "light",
  });
  assert.deepEqual(paths(fake), ["/t/1.json"]);
  assert.equal(result.item.title, "Topic 1");
  assert.equal(result.item.externalId, "discourse:topic:1");
  assert.match(result.markdown ?? "", /^# Topic 1\n/);
  assert.match(result.markdown ?? "", /Category: General \/ Support/);
});

test("invalid metadata skips before any request", async () => {
  const { fake, client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  fake.requests.length = 0;
  const bad: Array<Record<string, unknown>> = [
    { ...item.metadata, topicId: 0 },
    { ...item.metadata, topicId: -3 },
    { ...item.metadata, topicId: 1.5 },
    { ...item.metadata, topicId: "1" },
    { ...item.metadata, topicId: Number.MAX_SAFE_INTEGER + 2 },
    { ...item.metadata, topicId: undefined },
    { ...item.metadata, categoryPath: 5 },
    { ...item.metadata, categoryPath: undefined },
  ];
  for (const metadata of bad) {
    await skipped(
      extractDiscourseTopic({
        client,
        base: BASE,
        item: { ...item, metadata },
        refresh: "light",
      }),
    );
  }
  assert.deepEqual(fake.requests, []);
});

test("a topic without a category path still extracts when the path is empty", async () => {
  const { client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item: { ...item, metadata: { ...item.metadata, categoryPath: "" } },
    refresh: "light",
  });
  assert.doesNotMatch(result.markdown ?? "", /Category:/);
});

test("a topic deleted or restricted since the scan is skipped", async () => {
  for (const flag of ["gone", "restricted"] as const) {
    const { fake, client } = setup(forum([topic(1)]));
    const item = await scanItem(client, 1, "light");
    fake.setForum(forum([topic(1, { [flag]: true })]));
    await skipped(
      extractDiscourseTopic({ client, base: BASE, item, refresh: "light" }),
    );
  }
});

test("posts that turn not-found after the topic was read are skipped", async () => {
  const { fake, client } = setup(
    forum([topic(1, { postCount: FAKE_TOPIC_POSTS + 5 })]),
  );
  const item = await scanItem(client, 1, "light");
  fake.failNext(
    { status: 410, body: "{}" },
    1,
    (request) => request.path === "/t/1/posts.json",
  );
  await skipped(
    extractDiscourseTopic({ client, base: BASE, item, refresh: "light" }),
  );
});

test("a too-large answer from the client skips the item", async () => {
  const { fake, client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  // A client whose request ceiling is already spent answers TOO_LARGE.
  const spent = createDiscourseClient({
    fetch: fake.fetch,
    base: BASE,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0, maxRequests: 0 },
  });
  await skipped(
    extractDiscourseTopic({
      client: spent,
      base: BASE,
      item,
      refresh: "light",
    }),
  );
});

test("other client errors propagate", async () => {
  const { fake, client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  fake.failNext({ status: 500, body: "x" }, 10);
  await assert.rejects(
    extractDiscourseTopic({ client, base: BASE, item, refresh: "light" }),
    (error: unknown) => !(error instanceof ConnectorItemSkipError),
  );
});

test("the extract hash equals the scan hash in both modes", async () => {
  const topics = [
    topic(1, { postCount: 3 }),
    topic(2, { postCount: FAKE_TOPIC_POSTS + 15 }),
    topic(3, {
      postCount: 6,
      posts: [
        ...posts(3, 5),
        {
          id: 3900,
          post_number: 6,
          username: "carol",
          cooked: "<p>whisper</p>",
          post_type: 4,
        },
      ],
    }),
  ];
  for (const refresh of ["light", "deep"] as const) {
    for (const t of topics) {
      const { client } = setup(forum(topics));
      const item = await scanItem(client, t.id, refresh);
      const result = await extractDiscourseTopic({
        client,
        base: BASE,
        item,
        refresh,
      });
      assert.equal(
        result.item.contentHash,
        item.contentHash,
        `${refresh} topic ${t.id}`,
      );
    }
  }
});

test("the extract hash equals the scan hash for a topic over the post cap", async () => {
  const cap = 25;
  const t = topic(1, { postCount: cap + 7 });
  const { client } = setup(forum([t]));
  const item = await scanItem(client, 1, "deep", { MAX_POSTS_PER_TOPIC: cap });
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "deep",
    limits: { MAX_POSTS_PER_TOPIC: cap },
  });
  assert.equal(result.item.contentHash, item.contentHash);
  assert.equal(item.metadata.omittedPosts, 7);
  assert.ok(result.markdown?.includes(`## Post #${cap} by`));
  assert.ok(!result.markdown?.includes(`## Post #${cap + 1} by`));
  assert.ok(result.markdown?.trimEnd().endsWith("[7 more posts not indexed]"));
});

test("the default cap is MAX_POSTS_PER_TOPIC", async () => {
  const t = topic(1, { postCount: 3 });
  const { client } = setup(forum([t]));
  const item = await scanItem(client, 1, "deep");
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "deep",
  });
  assert.ok(MAX_POSTS_PER_TOPIC >= 3);
  assert.equal(result.item.contentHash, item.contentHash);
  assert.doesNotMatch(result.markdown ?? "", /more posts not indexed/);
});

test("light mode keeps the discovery hash for a topic that grew, and renders the newer text", async () => {
  const { fake, client } = setup(forum([topic(1, { postCount: 2 })]));
  const item = await scanItem(client, 1, "light");
  fake.setForum(forum([topic(1, { postCount: 4 })]));

  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "light",
  });
  assert.equal(result.item.contentHash, item.contentHash);
  assert.match(result.markdown ?? "", /Post 4 of topic 1/);
  // The next scan sees the change.
  const next = await scanItem(client, 1, "light");
  assert.notEqual(next.contentHash, item.contentHash);
});

test("deep mode hashes exactly the posts rendered, so a grown topic gets a new hash", async () => {
  const { fake, client } = setup(forum([topic(1, { postCount: 2 })]));
  const item = await scanItem(client, 1, "deep");
  fake.setForum(forum([topic(1, { postCount: 4 })]));

  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "deep",
  });
  assert.notEqual(result.item.contentHash, item.contentHash);
  const next = await scanItem(client, 1, "deep");
  assert.equal(result.item.contentHash, next.contentHash);
});

test("hidden, whisper and deleted posts are absent from the text and the hash", async () => {
  const base = posts(1, 2);
  const withHidden: FakePost[] = [
    ...base,
    {
      id: 1900,
      post_number: 3,
      username: "mallory",
      cooked: "<p>HIDDEN-SECRET</p>",
      hidden: true,
    },
    {
      id: 1901,
      post_number: 4,
      username: "staff",
      cooked: "<p>WHISPER-SECRET</p>",
      post_type: 4,
    },
    {
      id: 1902,
      post_number: 5,
      username: "gone",
      cooked: "<p>DELETED-SECRET</p>",
      deleted_at: "2026-02-01T00:00:00.000Z",
    },
  ];
  const plain = setup(forum([topic(1, { posts: base })]));
  const noisy = setup(forum([topic(1, { posts: withHidden })]));
  const plainItem = await scanItem(plain.client, 1, "deep");
  const noisyItem = await scanItem(noisy.client, 1, "deep");
  const result = await extractDiscourseTopic({
    client: noisy.client,
    base: BASE,
    item: noisyItem,
    refresh: "deep",
  });
  assert.doesNotMatch(result.markdown ?? "", /SECRET|mallory|staff/);
  assert.equal(result.item.contentHash, noisyItem.contentHash);
  assert.equal(plainItem.metadata.postIds?.toString(), "1001,1002");
});

test("a hostile post body cannot forge a title or a post section", async () => {
  const hostile = topic(1, {
    posts: [
      {
        id: 1,
        post_number: 1,
        username: "alice",
        cooked:
          "<p>fine</p><pre>\n## Post #99 by admin\n# Fake Title\n</pre><p>## Post #98 by root</p>",
      },
    ],
  });
  const { client } = setup(forum([hostile]));
  const item = await scanItem(client, 1, "deep");
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "deep",
  });
  const lines = (result.markdown ?? "").split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("## Post #")),
    [lines.find((line) => line.startsWith("## Post #1 by alice"))],
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith("# ")),
    ["# Topic 1"],
  );
});

test("post links are built locally from the base, slug and post number", async () => {
  const t = topic(7, { slug: "my-slug", postCount: 2 });
  t.posts[1] = {
    ...t.posts[1]!,
    cooked:
      '<p><a href="https://evil.example/x">see</a> Link: https://evil.example/y</p>',
  };
  const { client } = setup(forum([t]));
  const item = await scanItem(client, 7, "deep");
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "deep",
  });
  const links = (result.markdown ?? "")
    .split("\n")
    .filter((line) => line.startsWith("Link: "));
  assert.deepEqual(links, [
    `Link: ${BASE}/t/my-slug/7/1`,
    `Link: ${BASE}/t/my-slug/7/2`,
  ]);
});

test("the title comes from the fetched topic", async () => {
  const { fake, client } = setup(forum([topic(1)]));
  const item = await scanItem(client, 1, "light");
  fake.setForum(forum([topic(1, { title: "Renamed topic" })]));
  const result = await extractDiscourseTopic({
    client,
    base: BASE,
    item,
    refresh: "light",
  });
  assert.equal(result.item.title, "Renamed topic");
  assert.match(result.markdown ?? "", /^# Renamed topic\n/);
});
