import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSkillRunStatsView } from "./skill-run-stats";

// Who sees what: the full answer when the API gives it, the public line when
// it clears its floor, nothing otherwise. `fetch` is the only fake.
type Reply = { status: number; body: unknown };
let replies: { full: Reply; public: Reply };
const fetchMock = vi.fn(async (url: string) => {
  const reply = url.endsWith("?full=1") ? replies.full : replies.public;
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
});

const available = {
  available: true,
  runs: 124,
  successRate: 0.92,
  workspaces: 8,
  topErrors: [
    { errorClass: "missing_dependency", subject: "pptxgenjs", count: 6 },
  ],
  windowDays: 30,
};
const full = {
  skillId: "skill_1",
  runs: 3,
  successes: 2,
  successRate: 2 / 3,
  workspaces: 1,
  topErrors: [],
  windowDays: 30,
  publiclyVisible: false,
  computedAt: "2026-09-22T00:00:00.000Z",
};
const denied = (status: number) => ({
  status,
  body: { code: "X", message: "no" },
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  replies = { full: denied(403), public: { status: 200, body: available } };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("the author or an admin gets the full answer", async () => {
  replies.full = { status: 200, body: full };
  await expect(loadSkillRunStatsView("deck")).resolves.toEqual({
    kind: "full",
    stats: full,
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/\/v1\/skills\/deck\/run-stats\?full=1$/),
      expect.stringMatching(/\/v1\/skills\/deck\/run-stats$/),
    ]),
  );
});

test.each([401, 403, 404])(
  "anyone else (%i on full) falls back to the public line",
  async (status) => {
    replies.full = denied(status);
    await expect(loadSkillRunStatsView("deck")).resolves.toEqual({
      kind: "public",
      stats: available,
    });
  },
);

test("below the floor, nothing", async () => {
  replies.public = { status: 200, body: { available: false } };
  await expect(loadSkillRunStatsView("deck")).resolves.toEqual({
    kind: "none",
  });
});

test("a skill that is not public, nothing", async () => {
  replies.full = denied(404);
  replies.public = denied(404);
  await expect(loadSkillRunStatsView("deck")).resolves.toEqual({
    kind: "none",
  });
});

test("a server error is an error, not a quiet fallback", async () => {
  replies.full = denied(500);
  await expect(loadSkillRunStatsView("deck")).rejects.toMatchObject({
    status: 500,
  });
});

test("the slug is encoded", async () => {
  await loadSkillRunStatsView("a/b");
  expect(String(fetchMock.mock.calls[0]![0])).toContain(
    "/v1/skills/a%2Fb/run-stats",
  );
});
