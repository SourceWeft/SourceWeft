import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendSkillReviews,
  isSkillMarketAdminViewer,
  listSkillReviews,
  saveMySkillReview,
  setSkillReviewStatus,
  skillReviewErrorKind,
  skillReviewsQuery,
  type SkillReview,
} from "./skill-reviews";

const review = (id: string): SkillReview => ({
  id,
  rating: 4,
  body: "",
  status: "visible",
  version: null,
  reviewer: { name: null, image: null },
  authorReply: null,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<
    (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skillReviewsQuery", () => {
  it("leaves out what was not given", () => {
    expect(skillReviewsQuery({})).toBe("");
    expect(skillReviewsQuery({ cursor: null })).toBe("");
    expect(
      skillReviewsQuery({ sort: "highest", cursor: "a b", limit: 5 }),
    ).toBe("?sort=highest&cursor=a+b&limit=5");
  });
});

describe("skillReviewErrorKind", () => {
  it("reads the status and the API's code", () => {
    expect(skillReviewErrorKind({ status: 429 })).toBe("rate_limited");
    expect(
      skillReviewErrorKind({ status: 400, code: "SKILL_REVIEW_RATE_LIMITED" }),
    ).toBe("rate_limited");
    expect(
      skillReviewErrorKind({ status: 403, code: "SKILL_REVIEW_NOT_INSTALLED" }),
    ).toBe("not_installed");
    expect(skillReviewErrorKind({ status: 403 })).toBe("forbidden");
    expect(skillReviewErrorKind({ status: 401 })).toBe("forbidden");
    expect(skillReviewErrorKind({ status: 404 })).toBe("not_found");
    expect(skillReviewErrorKind({ status: 500 })).toBe("other");
    expect(skillReviewErrorKind(new Error("network"))).toBe("other");
    expect(skillReviewErrorKind(null)).toBe("other");
  });
});

describe("appendSkillReviews", () => {
  it("appends the next page without repeating a review already shown", () => {
    const shown = [review("a"), review("b")];
    expect(
      appendSkillReviews(shown, [review("b"), review("c")]).map((r) => r.id),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("the API calls", () => {
  it("reads a page by slug, with the query", async () => {
    const fetchMock = stubFetch(200, { items: [] });
    await listSkillReviews("pdf tools", { sort: "lowest", cursor: "c1" });
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /\/v1\/skills\/pdf%20tools\/reviews\?sort=lowest&cursor=c1$/,
    );
  });

  it("puts the viewer's review as rating and body only", async () => {
    const fetchMock = stubFetch(200, { review: review("a") });
    await saveMySkillReview("pdf", { rating: 5, body: "Great" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/skills\/pdf\/reviews\/mine$/);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      rating: 5,
      body: "Great",
    });
  });

  it("moderates through the admin route", async () => {
    const fetchMock = stubFetch(200, {});
    await setSkillReviewStatus("rev/1", "hidden");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(
      /\/v1\/skills\/registry\/admin\/reviews\/rev%2F1\/status$/,
    );
    expect(JSON.parse(String(init?.body))).toEqual({ status: "hidden" });
  });

  it("a 429 surfaces with its status, so the UI can say so", async () => {
    stubFetch(429, { code: "SKILL_REVIEW_RATE_LIMITED", message: "slow" });
    const error = await saveMySkillReview("pdf", { rating: 5, body: "" }).catch(
      (caught: unknown) => caught,
    );
    expect(skillReviewErrorKind(error)).toBe("rate_limited");
  });
});

describe("isSkillMarketAdminViewer", () => {
  it("is the API's answer", async () => {
    stubFetch(200, { isMarketAdmin: true });
    expect(await isSkillMarketAdminViewer()).toBe(true);
    stubFetch(200, { isMarketAdmin: false });
    expect(await isSkillMarketAdminViewer()).toBe(false);
  });

  it("any failure reads as not an admin", async () => {
    stubFetch(401, { code: "UNAUTHORIZED", message: "no" });
    expect(await isSkillMarketAdminViewer()).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await isSkillMarketAdminViewer()).toBe(false);
  });
});
