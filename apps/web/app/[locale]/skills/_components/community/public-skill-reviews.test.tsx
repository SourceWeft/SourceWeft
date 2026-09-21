// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ListSkillReviewsResponse,
  SkillReview,
} from "../../../../../lib/skill-reviews";

// The public reviews section: the server render from the anonymous first
// page, the call to action, "Show more" and reporting one review.

const server = vi.hoisted(() => ({ getPublicSkillReviews: vi.fn() }));
const client = vi.hoisted(() => ({ listSkillReviews: vi.fn() }));

vi.mock("../../../../../lib/public-skill-reviews", () => ({
  ...server,
  PUBLIC_SKILL_REVIEWS_PAGE_SIZE: 2,
}));
vi.mock("../../../../../lib/skill-reviews", () => client);
// The report form is the reports feature's; here it only has to receive the
// review it is about.
vi.mock(
  "../../../../dashboard/skills/_components/community/skill-report-form",
  () => ({
    SkillReportForm: (props: {
      reviewId?: string;
      signedIn: boolean;
      slug: string;
    }) => (
      <p data-testid="report-form">
        {`${props.slug}:${props.reviewId}:${props.signedIn}`}
      </p>
    ),
  }),
);

import { PublicSkillReviews } from "./public-skill-reviews";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function review(id: string, extra: Partial<SkillReview> = {}): SkillReview {
  return {
    id,
    rating: 5,
    body: `Body of ${id}`,
    status: "visible",
    version: "1.0.0",
    reviewer: { name: `Reviewer ${id}`, image: null },
    authorReply: null,
    createdAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...extra,
  };
}

function page(
  extra: Partial<ListSkillReviewsResponse> = {},
): ListSkillReviewsResponse {
  return {
    items: [review("r1"), review("r2", { rating: 3 })],
    nextCursor: null,
    summary: {
      count: 2,
      average: 4,
      distribution: { "1": 0, "2": 0, "3": 1, "4": 0, "5": 1 },
    },
    viewer: { canReview: false, reason: "signed_out", canReply: false },
    ...extra,
  };
}

const empty = () =>
  page({
    items: [],
    summary: {
      count: 0,
      average: null,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    },
  });

async function renderSection(signedIn: boolean) {
  const node = await PublicSkillReviews({
    slug: "pdf-tools",
    signedIn,
    locale: "en",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(node));
  return node;
}

const section = () =>
  container.querySelector('[data-testid="public-skill-reviews"]');
const cta = () =>
  container.querySelector<HTMLAnchorElement>(
    '[data-testid="public-skill-reviews-cta"]',
  );
const itemIds = () =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="skill-review-item"]',
    ),
  ].map((node) => node.dataset.reviewId);
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );

beforeEach(() => {
  vi.clearAllMocks();
  server.getPublicSkillReviews.mockResolvedValue(page());
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

test("renders the summary and the first page, anchored as #reviews", async () => {
  await renderSection(false);
  expect(server.getPublicSkillReviews).toHaveBeenCalledWith("pdf-tools");
  expect(section()?.id).toBe("reviews");
  expect(container.textContent).toContain("Ratings and reviews");
  expect(
    container.querySelector('[data-testid="skill-review-summary"]'),
  ).not.toBeNull();
  expect(itemIds()).toEqual(["r1", "r2"]);
  expect(container.textContent).toContain("Body of r2");
  expect(button("Show more reviews")).toBeUndefined();
});

test("the call to action: sign in to review, or write one in the dashboard", async () => {
  await renderSection(false);
  expect(cta()?.textContent).toContain("Sign in to review");
  expect(cta()?.getAttribute("href")).toBe(
    "/auth/sign-in?redirectTo=%2Fdashboard%2Fskills%2Fpdf-tools%23reviews",
  );
  act(() => root.unmount());
  container.remove();

  await renderSection(true);
  expect(cta()?.textContent).toContain("Write a review");
  expect(cta()?.getAttribute("href")).toBe(
    "/dashboard/skills/pdf-tools#reviews",
  );
});

test("no reviews: nothing for a visitor, only the call to action when signed in", async () => {
  server.getPublicSkillReviews.mockResolvedValue(empty());
  expect(await renderSection(false)).toBeNull();
  expect(section()).toBeNull();
  act(() => root.unmount());
  container.remove();

  await renderSection(true);
  expect(section()).not.toBeNull();
  expect(cta()?.textContent).toContain("Write a review");
  expect(
    container.querySelector('[data-testid="skill-review-summary"]'),
  ).toBeNull();
  expect(itemIds()).toEqual([]);
});

test("a skill whose reviews cannot be read renders nothing", async () => {
  server.getPublicSkillReviews.mockResolvedValue(null);
  expect(await renderSection(true)).toBeNull();
});

test("Show more loads the next page in the browser and appends it once", async () => {
  server.getPublicSkillReviews.mockResolvedValue(page({ nextCursor: "c1" }));
  client.listSkillReviews.mockResolvedValueOnce(
    page({ items: [review("r2"), review("r3")], nextCursor: "c2" }),
  );
  client.listSkillReviews.mockResolvedValueOnce(
    page({ items: [review("r4")], nextCursor: null }),
  );
  await renderSection(false);
  await act(async () => button("Show more reviews")!.click());
  expect(client.listSkillReviews).toHaveBeenLastCalledWith("pdf-tools", {
    sort: "newest",
    cursor: "c1",
    limit: 2,
  });
  expect(itemIds()).toEqual(["r1", "r2", "r3"]);
  await act(async () => button("Show more reviews")!.click());
  expect(client.listSkillReviews).toHaveBeenLastCalledWith("pdf-tools", {
    sort: "newest",
    cursor: "c2",
    limit: 2,
  });
  expect(itemIds()).toEqual(["r1", "r2", "r3", "r4"]);
  expect(button("Show more reviews")).toBeUndefined();
});

test("a failed Show more says so and can be tried again", async () => {
  server.getPublicSkillReviews.mockResolvedValue(page({ nextCursor: "c1" }));
  client.listSkillReviews.mockRejectedValueOnce(new Error("offline"));
  await renderSection(false);
  await act(async () => button("Show more reviews")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be loaded",
  );
  expect(button("Show more reviews")).toBeDefined();
});

test("Report opens the report form for that one review", async () => {
  await renderSection(false);
  const reports = container.querySelectorAll<HTMLButtonElement>(
    '[data-testid="public-review-report"]',
  );
  expect(reports).toHaveLength(2);
  await act(async () => reports[1]!.click());
  expect(
    document.querySelector('[data-testid="report-form"]')?.textContent,
  ).toBe("pdf-tools:r2:false");
  expect(document.body.textContent).toContain("Report this review");
});
