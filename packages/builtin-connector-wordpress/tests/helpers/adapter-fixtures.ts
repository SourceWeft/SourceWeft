import type { ConnectorPublicFetchScope } from "@sourceweft/contracts/capability-host-services";
import {
  createWordPressAdapter,
  type WordPressAdapterInput,
} from "../../src/adapter";
import {
  createFakeWordPress,
  type FakePost,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./fake-wordpress";

export const SITE_URL = "https://site.example";
export const CREDENTIAL = { username: "editor", secret: "aaaa bbbb cccc dddd" };

type AdapterLimits = NonNullable<WordPressAdapterInput["limits"]>;

export type Harness = {
  fake: FakeWordPress;
  opened: () => number;
  closed: () => number;
  warnings: Array<{ message: string; meta?: Record<string, unknown> }>;
  adapter: ReturnType<typeof createWordPressAdapter>;
};

export function harness(input: {
  flavor: "public" | "login";
  fake?: Partial<FakeWordPressOptions>;
  limits?: AdapterLimits;
}): Harness {
  const fake = createFakeWordPress({ siteBase: SITE_URL, ...input.fake });
  let opened = 0;
  let closed = 0;
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const scope = (): ConnectorPublicFetchScope => {
    opened += 1;
    return {
      fetch: fake.fetch,
      close: async () => {
        closed += 1;
      },
    };
  };
  const logger = {
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta });
    },
  };
  const limits: AdapterLimits = { minRequestGapMs: 0, ...input.limits };
  const adapter =
    input.flavor === "public"
      ? createWordPressAdapter({
          flavor: "public",
          publicFetch: scope,
          logger,
          limits,
        })
      : createWordPressAdapter({
          flavor: "login",
          credentialedFetch: scope,
          logger,
          limits,
        });
  return {
    fake,
    opened: () => opened,
    closed: () => closed,
    warnings,
    adapter,
  };
}

/** A config `{ siteUrl, items, ...extra }`; items default to none (everything). */
export const wpConfig = (
  items: Array<{ id: string; kind: string }> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ siteUrl: SITE_URL, items, ...extra });

/** `[{ id, kind }]` where each kind is the id's own prefix. */
export const sel = (...ids: string[]): Array<{ id: string; kind: string }> =>
  ids.map((id) => ({ id, kind: id.slice(0, id.indexOf(":")) }));

/** The stored credential, as the create/rotate flow encrypts it. */
export const credentialToken = (
  credential: { username: string; secret: string } = CREDENTIAL,
): string => JSON.stringify(credential);

export const baseInput = (
  config: Record<string, unknown> = wpConfig(),
  accessToken = "",
) => ({
  teamId: "t",
  workspaceId: "w",
  connectorId: "c",
  connectorType: "wordpress",
  config,
  accessToken,
});

export const actionInput = (
  actionType: string,
  request: Record<string, unknown>,
  config: Record<string, unknown> = wpConfig(),
  accessToken = "",
) => ({
  teamId: "t",
  workspaceId: "w",
  connectorId: "c",
  connectorType: "wordpress",
  actionType,
  request,
  config,
  accessToken,
  idempotencyKey: "k",
});

/** A tidy structured post with one category and one tag. */
export function fakePost(id: number, over: Partial<FakePost> = {}): FakePost {
  return {
    id,
    type: "post",
    title: `Post ${id}`,
    categories: [10],
    tags: [20],
    author: 5,
    ...over,
  };
}

/** `count` published posts and `pages` published pages, titles "Entry N". */
export function manyEntries(count: number, pages: number): FakePost[] {
  const out: FakePost[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({ id: i, type: "post", title: `Entry ${i}` });
  }
  for (let i = 0; i < pages; i += 1) {
    const id = count + i + 1;
    out.push({ id, type: "page", title: `Entry ${id}` });
  }
  return out;
}
