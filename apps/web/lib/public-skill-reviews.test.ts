import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The cache is Next's; here every call goes through.
vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
}));

import {
  getPublicSkillReviews,
  PUBLIC_SKILL_REVIEWS_PAGE_SIZE,
} from "./public-skill-reviews";

const page = {
  items: [],
  nextCursor: null,
  summary: {
    count: 0,
    average: null,
    distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
  },
  viewer: { canReview: false, reason: "signed_out", canReply: false },
};

let fetchMock: ReturnType<typeof vi.fn>;
function respond(status: number, body: unknown) {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => respond(200, page));
afterEach(() => vi.unstubAllGlobals());

test("reads the first page, newest first, anonymously", async () => {
  expect(await getPublicSkillReviews("pdf tools")).toEqual(page);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toMatch(
    new RegExp(
      `/v1/skills/pdf%20tools/reviews\\?sort=newest&limit=${PUBLIC_SKILL_REVIEWS_PAGE_SIZE}$`,
    ),
  );
  expect(init.credentials).toBe("omit");
});

test("anything but a good answer is no reviews, never a broken page", async () => {
  respond(404, { code: "NOT_FOUND", message: "Skill not found" });
  expect(await getPublicSkillReviews("secret")).toBeNull();
  respond(500, { code: "INTERNAL", message: "boom" });
  expect(await getPublicSkillReviews("pdf")).toBeNull();
  respond(200, { items: "nope" });
  expect(await getPublicSkillReviews("pdf")).toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  expect(await getPublicSkillReviews("pdf")).toBeNull();
});
