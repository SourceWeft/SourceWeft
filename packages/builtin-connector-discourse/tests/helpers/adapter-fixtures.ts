import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import { createDiscourseAdapter } from "../../src/adapter";
import {
  startFakeDiscourse,
  type FakeCategory,
  type FakeDiscourse,
  type FakeForum,
  type FakeTopic,
} from "./fake-discourse";

export const FORUM_URL = "https://forum.example.com";

export function fakeTopic(
  id: number,
  options: Partial<FakeTopic> = {},
): FakeTopic {
  return {
    id,
    title: `Topic ${id}`,
    slug: `topic-${id}`,
    category_id: 10,
    posts: [
      {
        id: id * 1000 + 1,
        post_number: 1,
        username: "alice",
        cooked: `<p>Hello from topic ${id}</p>`,
      },
      {
        id: id * 1000 + 2,
        post_number: 2,
        username: "bob",
        cooked: "<p>A reply</p>",
      },
    ],
    ...options,
  };
}

/**
 * Categories: 10 General (child 11 Support), 12 Staff (read-restricted, child
 * 14), 13 Empty (no topics, no children), 15 Alpha (a second top-level one).
 * Topics 1..`topics` sit in category 10; topic 900 is in the restricted
 * category 12 and topic 901 in the unrestricted category 11.
 */
export function adapterForum(
  options: { topics?: number; categories?: FakeCategory[] } = {},
): FakeForum {
  const count = options.topics ?? 3;
  const topics: FakeTopic[] = [];
  for (let i = 1; i <= count; i += 1) topics.push(fakeTopic(i));
  topics.push(fakeTopic(900, { category_id: 12, title: "Staff only" }));
  topics.push(fakeTopic(901, { category_id: 11, title: "Support question" }));
  return {
    categories: options.categories ?? [
      { id: 10, name: "General", slug: "general", topic_count: count },
      { id: 11, name: "support", slug: "support", parent_category_id: 10 },
      { id: 12, name: "Staff", slug: "staff", read_restricted: true },
      { id: 13, name: "Empty", slug: "empty", topic_count: 0 },
      { id: 14, name: "Hidden child", slug: "hc", parent_category_id: 12 },
      { id: 15, name: "alpha", slug: "alpha", topic_count: 1 },
    ],
    topics,
  };
}

export type Harness = {
  fake: FakeDiscourse;
  opened: () => number;
  closed: () => number;
  adapter: ReturnType<typeof createDiscourseAdapter>;
};

export function harness(
  forum: FakeForum,
  options: {
    limits?: Parameters<typeof createDiscourseAdapter>[0]["limits"];
  } = {},
): Harness {
  const fake = startFakeDiscourse(forum);
  let opened = 0;
  let closed = 0;
  const publicFetch = (): ConnectorPublicFetchScope => {
    opened += 1;
    return {
      fetch: fake.fetch,
      close: async () => {
        closed += 1;
      },
    };
  };
  const adapter = createDiscourseAdapter({
    publicFetch,
    limits: { minRequestGapMs: 0, ...options.limits },
  });
  return { fake, opened: () => opened, closed: () => closed, adapter };
}

export const forumConfig = (
  items: Array<{ id: string; kind: string }> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  forumUrl: FORUM_URL,
  items,
  ...extra,
});

export const baseInput = (config: Record<string, unknown> = forumConfig()) => ({
  teamId: "t",
  workspaceId: "w",
  connectorId: "c",
  connectorType: "discourse",
  config,
  accessToken: "",
});
