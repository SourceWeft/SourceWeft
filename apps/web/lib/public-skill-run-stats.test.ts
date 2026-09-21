import { afterEach, beforeEach, expect, test, vi } from "vitest";

const cacheCalls = vi.hoisted(
  () => [] as { keys: string[]; options: { revalidate?: number } }[],
);

vi.mock("server-only", () => ({}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.mock("next/cache", () => ({
  // A pass-through: what matters is what the callback does on failure.
  unstable_cache: (
    callback: (...args: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    cacheCalls.push({ keys, options });
    return callback;
  },
}));

import { getPublicSkillRunStats } from "./public-skill-run-stats";

const available = {
  available: true,
  runs: 12,
  successRate: 0.75,
  workspaces: 4,
  topErrors: [{ errorClass: "timeout", subject: null, count: 3 }],
  windowDays: 30,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

test("cached with the public page's revalidate", () => {
  expect(cacheCalls).toEqual([
    { keys: ["public-skill-run-stats"], options: { revalidate: 60 } },
  ]);
});

test("available stats, fetched anonymously by slug", async () => {
  reply(200, available);
  await expect(getPublicSkillRunStats("a/b")).resolves.toEqual(available);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://api.test/v1/skills/a%2Fb/run-stats");
  expect(init?.credentials).toBeUndefined();
});

test.each([
  ["below the floor", () => reply(200, { available: false })],
  ["not public", () => reply(404, { code: "NOT_FOUND", message: "x" })],
  ["a server error", () => reply(500, {})],
  ["a malformed answer", () => reply(200, { available: true, runs: -1 })],
  ["a network failure", () => fetchMock.mockRejectedValue(new Error("down"))],
])("null for %s", async (_label, arrange) => {
  arrange();
  await expect(getPublicSkillRunStats("deck")).resolves.toBeNull();
});
