import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  ICON_PROBE_MISS_MAX_AGE_MS,
  registryIcons,
  storedIconProbe,
  type IconTarget,
  type StoredIconProvenance,
} from "./registry-icons";
import type { McpIconStore } from "./store";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function target(
  identifier: string,
  extra: Partial<IconTarget> = {},
): IconTarget {
  return { key: `${identifier}@1`, identifier, ...extra };
}

function png(status = 200) {
  return new Response(new Uint8Array(Buffer.alloc(2048, 1)), {
    status,
    headers: { "content-type": "image/png" },
  });
}

/** A fetch that answers every favicon-service call with `answer` and counts. */
function faviconFetch(answer: (url: string) => Response) {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return answer(url);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
}

function memoryStore() {
  const writes: Array<{ domain: string; contentType: string; size: number }> =
    [];
  const store: McpIconStore = async (input) => {
    writes.push({
      domain: input.domain,
      contentType: input.contentType,
      size: input.bytes.byteLength,
    });
    return {
      url: `https://assets.test/market/mcp-icons/${input.domain}/x.png`,
    };
  };
  return { store, writes };
}

async function run(
  targets: IconTarget[],
  options: {
    stored?: Map<string, StoredIconProvenance>;
    fetchImpl?: typeof globalThis.fetch;
    store?: McpIconStore;
    storeConfigured?: boolean;
  } = {},
) {
  return registryIcons(targets, {
    now: NOW,
    stored: options.stored ?? new Map(),
    fetchImpl:
      options.fetchImpl ??
      (vi.fn(async () => {
        throw new Error("no fetch expected");
      }) as unknown as typeof globalThis.fetch),
    store: options.store ?? memoryStore().store,
    storeConfigured: options.storeConfigured ?? true,
  });
}

test("entries with a static source never fetch; an io.github entry is a github-avatar", async () => {
  const result = await run([
    target("io.github.acme/server"),
    target("com.acme/server", {
      registryIconUrl: "https://cdn.acme.test/icon.png",
    }),
    target("com.other/server", {
      repositoryUrl: "https://github.com/other-org/server",
    }),
  ]);
  assert.deepEqual(result.icons.get("io.github.acme/server@1"), {
    iconUrl: "https://github.com/acme.png?size=128",
    iconSource: "github-avatar",
    iconProbe: undefined,
  });
  assert.equal(result.icons.get("com.acme/server@1")?.iconSource, "registry");
  assert.deepEqual(result.icons.get("com.other/server@1"), {
    iconUrl: "https://github.com/other-org.png?size=128",
    iconSource: "github-avatar",
    iconProbe: undefined,
  });
  assert.equal(result.faviconFetched, 0);
});

test("sibling provenance is read defensively: server-info and github-registry sources", async () => {
  const stored = new Map<string, StoredIconProvenance>([
    [
      "com.notion/mcp@1",
      {
        selfDescription: {
          serverInfo: { icons: [{ src: "https://notion.test/icon.png" }] },
        },
      },
    ],
    [
      "com.acme/mcp@1",
      {
        selfDescription: { serverInfo: {} },
        githubRegistry: {
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
        },
      },
    ],
    ["com.broken/mcp@1", { selfDescription: "nonsense", githubRegistry: 42 }],
  ]);
  const result = await run(
    [
      target("com.notion/mcp"),
      target("com.acme/mcp"),
      target("com.broken/mcp"),
    ],
    { stored, storeConfigured: false },
  );
  assert.deepEqual(result.icons.get("com.notion/mcp@1"), {
    iconUrl: "https://notion.test/icon.png",
    iconSource: "server-info",
    iconProbe: undefined,
  });
  assert.deepEqual(result.icons.get("com.acme/mcp@1"), {
    iconUrl: "https://avatars.githubusercontent.com/u/9?v=4",
    iconSource: "github-registry",
    iconProbe: undefined,
  });
  assert.deepEqual(result.icons.get("com.broken/mcp@1"), {
    iconSource: "placeholder",
  });
  assert.equal(result.faviconSkipped, 1);
});

test("a domain entry without a static source gets its favicon fetched once, stored, and labelled favicon", async () => {
  const { fetch, urls } = faviconFetch(() => png());
  const { store, writes } = memoryStore();
  const result = await run(
    [
      target("com.notion/mcp"),
      target("com.notion/other"),
      target("io.github.acme/server"),
    ],
    { fetchImpl: fetch, store },
  );
  // Two entries share notion.com: one fetch, one write.
  assert.deepEqual(urls, [
    "https://www.google.com/s2/favicons?domain=notion.com&sz=128",
  ]);
  assert.deepEqual(writes, [
    { domain: "notion.com", contentType: "image/png", size: 2048 },
  ]);
  const icon = result.icons.get("com.notion/mcp@1");
  assert.equal(icon?.iconSource, "favicon");
  assert.equal(
    icon?.iconUrl,
    "https://assets.test/market/mcp-icons/notion.com/x.png",
  );
  assert.deepEqual(icon?.iconProbe, {
    domain: "notion.com",
    result: "hit",
    probedAt: NOW.toISOString(),
    url: "https://assets.test/market/mcp-icons/notion.com/x.png",
    service: "google",
  });
  assert.deepEqual(result.icons.get("com.notion/other@1"), icon);
  assert.equal(result.faviconFetched, 1);
  assert.equal(result.faviconHits, 1);
  assert.equal(result.faviconFailed, 0);
});

test("a miss is cached as a miss; a failure is not cached and leaves a placeholder", async () => {
  const miss = faviconFetch(() => png(404));
  const missed = await run([target("com.unknown/mcp")], {
    fetchImpl: miss.fetch,
  });
  assert.deepEqual(missed.icons.get("com.unknown/mcp@1"), {
    iconSource: "placeholder",
    iconProbe: {
      domain: "unknown.com",
      result: "miss",
      probedAt: NOW.toISOString(),
    },
  });
  assert.equal(miss.urls.length, 2);

  const failing = faviconFetch(() => {
    throw new TypeError("fetch failed");
  });
  const failed = await run([target("com.flaky/mcp")], {
    fetchImpl: failing.fetch,
  });
  assert.deepEqual(failed.icons.get("com.flaky/mcp@1"), {
    iconSource: "placeholder",
    iconProbe: undefined,
  });
  assert.equal(failed.faviconFailed, 1);
});

test("a stored hit is reused without a fetch; a stored miss is reused for 30 days, then retried", async () => {
  const hit = {
    domain: "notion.com",
    result: "hit",
    probedAt: new Date(NOW.getTime() - 400 * DAY_MS).toISOString(),
    url: "https://assets.test/market/mcp-icons/notion.com/old.png",
    service: "duckduckgo",
  };
  const reused = await run([target("com.notion/mcp")], {
    stored: new Map([["com.notion/mcp@1", { iconProbe: hit }]]),
  });
  assert.deepEqual(reused.icons.get("com.notion/mcp@1"), {
    iconUrl: hit.url,
    iconSource: "favicon",
    iconProbe: hit,
  });
  assert.equal(reused.faviconFetched, 0);

  const recentMiss = {
    domain: "unknown.com",
    result: "miss",
    probedAt: new Date(NOW.getTime() - 29 * DAY_MS).toISOString(),
  };
  const kept = await run([target("com.unknown/mcp")], {
    stored: new Map([["com.unknown/mcp@1", { iconProbe: recentMiss }]]),
  });
  assert.deepEqual(kept.icons.get("com.unknown/mcp@1"), {
    iconSource: "placeholder",
    iconProbe: recentMiss,
  });
  assert.equal(kept.faviconFetched, 0);

  const staleMiss = {
    ...recentMiss,
    probedAt: new Date(
      NOW.getTime() - ICON_PROBE_MISS_MAX_AGE_MS,
    ).toISOString(),
  };
  const { fetch, urls } = faviconFetch(() => png());
  const retried = await run([target("com.unknown/mcp")], {
    stored: new Map([["com.unknown/mcp@1", { iconProbe: staleMiss }]]),
    fetchImpl: fetch,
  });
  assert.equal(retried.icons.get("com.unknown/mcp@1")?.iconSource, "favicon");
  assert.equal(urls.length, 1);
});

test("a registry icon added later wins, and the favicon cache is carried along", async () => {
  const hit = {
    domain: "notion.com",
    result: "hit",
    probedAt: NOW.toISOString(),
    url: "https://assets.test/market/mcp-icons/notion.com/old.png",
  };
  const result = await run(
    [
      target("com.notion/mcp", {
        registryIconUrl: "https://registry.test/notion.png",
      }),
    ],
    { stored: new Map([["com.notion/mcp@1", { iconProbe: hit }]]) },
  );
  assert.deepEqual(result.icons.get("com.notion/mcp@1"), {
    iconUrl: "https://registry.test/notion.png",
    iconSource: "registry",
    iconProbe: hit,
  });
});

test("stored probes are reused only when well-formed and for the same domain", () => {
  const hit = {
    domain: "notion.com",
    result: "hit",
    probedAt: NOW.toISOString(),
    url: "https://assets.test/x.png",
  };
  assert.ok(storedIconProbe(hit, "notion.com", NOW));
  assert.equal(storedIconProbe(hit, "other.com", NOW), undefined);
  assert.equal(
    storedIconProbe({ ...hit, url: undefined }, "notion.com", NOW),
    undefined,
  );
  assert.equal(
    storedIconProbe(
      { ...hit, url: "http://assets.test/x.png" },
      "notion.com",
      NOW,
    ),
    undefined,
  );
  assert.equal(
    storedIconProbe({ ...hit, probedAt: "yesterday" }, "notion.com", NOW),
    undefined,
  );
  assert.equal(
    storedIconProbe({ ...hit, result: "maybe" }, "notion.com", NOW),
    undefined,
  );
  assert.equal(storedIconProbe("hit", "notion.com", NOW), undefined);
  // A miss from the future is not trusted.
  assert.equal(
    storedIconProbe(
      {
        domain: "notion.com",
        result: "miss",
        probedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
      },
      "notion.com",
      NOW,
    ),
    undefined,
  );
});

test("without public storage no favicon is fetched; the entry stays a placeholder and is counted", async () => {
  const { fetch, urls } = faviconFetch(() => png());
  const result = await run([target("com.notion/mcp")], {
    fetchImpl: fetch,
    storeConfigured: false,
  });
  assert.deepEqual(result.icons.get("com.notion/mcp@1"), {
    iconSource: "placeholder",
  });
  assert.equal(urls.length, 0);
  assert.equal(result.faviconSkipped, 1);
});
