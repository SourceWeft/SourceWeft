// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ListSkillReviewsResponse,
  SkillReview,
} from "../../../../../lib/skill-reviews";

// The dashboard's reviews section against a mocked API: what it shows for
// each viewer, and what each control sends.

const api = vi.hoisted(() => ({
  listSkillReviews: vi.fn(),
  saveMySkillReview: vi.fn(),
  deleteMySkillReview: vi.fn(),
  saveSkillReviewReply: vi.fn(),
  deleteSkillReviewReply: vi.fn(),
  setSkillReviewStatus: vi.fn(),
  isSkillMarketAdminViewer: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../../../../../lib/skill-reviews", async (importActual) => ({
  ...(await importActual<typeof import("../../../../../lib/skill-reviews")>()),
  ...api,
}));
vi.mock("sonner", () => ({ toast }));

import { SkillReviews } from "./skill-reviews";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function review(id: string, extra: Partial<SkillReview> = {}): SkillReview {
  return {
    id,
    rating: 4,
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
    items: [review("r1"), review("r2", { rating: 2 })],
    nextCursor: null,
    summary: {
      count: 2,
      average: 3,
      distribution: { "1": 0, "2": 1, "3": 0, "4": 1, "5": 0 },
    },
    viewer: { canReview: true, canReply: false },
    ...extra,
  };
}

const flush = () => act(async () => {});

async function renderReviews() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      withIntl(
        <SkillReviews
          skillId="skill-1"
          catalogId="skill-1:v1"
          slug="pdf-tools"
          workspaceId="ws-1"
        />,
      ),
    ),
  );
  await flush();
}

const buttons = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].filter(
    (node) => node.textContent?.trim() === label,
  );
const button = (label: string, scope?: ParentNode) => buttons(label, scope)[0]!;
const item = (id: string) =>
  container.querySelector<HTMLElement>(
    `[data-review-id="${id}"]:not([data-testid="skill-review-own"] *)`,
  )!;
const own = () =>
  container.querySelector<HTMLElement>('[data-testid="skill-review-own"]')!;
const click = (node: HTMLElement) => act(async () => node.click());

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listSkillReviews.mockResolvedValue(page());
  api.isSkillMarketAdminViewer.mockResolvedValue(false);
  api.saveMySkillReview.mockResolvedValue({ review: review("mine") });
  api.deleteMySkillReview.mockResolvedValue({ deleted: true });
  api.setSkillReviewStatus.mockResolvedValue({});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("shows the summary and the list, newest first by default", async () => {
  await renderReviews();
  expect(api.listSkillReviews).toHaveBeenCalledWith("pdf-tools", {
    sort: "newest",
  });
  expect(container.textContent).toContain("Ratings and reviews");
  expect(container.textContent).toContain("3.0");
  expect(container.textContent).toContain("2 reviews");
  expect(
    container.querySelectorAll('[data-testid="skill-review-item"]'),
  ).toHaveLength(2);
  // Neither a reply nor a moderation control for an ordinary viewer.
  expect(buttons("Reply")).toHaveLength(0);
  expect(buttons("Hide")).toHaveLength(0);
});

test("sorting reloads; load more appends the next page", async () => {
  api.listSkillReviews.mockResolvedValue(page({ nextCursor: "c1" }));
  await renderReviews();
  api.listSkillReviews.mockResolvedValueOnce(
    page({ items: [review("r2"), review("r3")], nextCursor: null }),
  );
  await click(button("Load more"));
  expect(api.listSkillReviews).toHaveBeenLastCalledWith("pdf-tools", {
    sort: "newest",
    cursor: "c1",
  });
  expect(
    [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="skill-review-item"]',
      ),
    ].map((node) => node.dataset.reviewId),
  ).toEqual(["r1", "r2", "r3"]);
  expect(buttons("Load more")).toHaveLength(0);

  await click(button("Lowest rated"));
  await flush();
  expect(api.listSkillReviews).toHaveBeenLastCalledWith("pdf-tools", {
    sort: "lowest",
  });
  expect(button("Lowest rated").getAttribute("aria-pressed")).toBe("true");
});

test("writing a review: pick stars, type, save — with a counter", async () => {
  await renderReviews();
  const save = button("Save review", own());
  expect(save.disabled).toBe(true);
  expect(own().textContent).toContain("Choose a rating first.");
  await click(own().querySelectorAll<HTMLElement>('[role="radio"]')[4]!);
  const textarea = own().querySelector("textarea")!;
  expect(textarea.maxLength).toBe(2000);
  await act(async () => typeInto(textarea, "  Great skill  "));
  expect(
    own().querySelector('[data-testid="skill-review-char-count"]')?.textContent,
  ).toBe("15/2000");
  await click(button("Save review", own()));
  await flush();
  expect(api.saveMySkillReview).toHaveBeenCalledWith("pdf-tools", {
    rating: 5,
    body: "Great skill",
  });
  expect(toast.success).toHaveBeenCalledWith("Review saved");
  // The page is read again, so the summary includes the new review.
  expect(api.listSkillReviews).toHaveBeenCalledTimes(2);
});

test("a 429 says so and keeps the form", async () => {
  api.saveMySkillReview.mockRejectedValue({
    status: 429,
    code: "SKILL_REVIEW_RATE_LIMITED",
  });
  await renderReviews();
  await click(own().querySelectorAll<HTMLElement>('[role="radio"]')[2]!);
  await click(button("Save review", own()));
  await flush();
  expect(toast.error).toHaveBeenCalledWith(
    "You have changed reviews too often. Try again in a little while.",
  );
  expect(
    own().querySelector('[data-testid="skill-review-editor"]'),
  ).not.toBeNull();
});

test("an existing review is shown, then edited or deleted", async () => {
  const mine = review("mine", { rating: 3, body: "Okay" });
  api.listSkillReviews.mockResolvedValue(
    page({ viewer: { canReview: true, canReply: false, ownReview: mine } }),
  );
  await renderReviews();
  expect(own().textContent).toContain("Your review");
  expect(own().textContent).toContain("Okay");
  await click(button("Edit", own()));
  expect(own().querySelector("textarea")?.value).toBe("Okay");
  expect(
    own().querySelectorAll('[role="radio"]')[2]!.getAttribute("aria-checked"),
  ).toBe("true");
  await click(button("Cancel", own()));
  await click(button("Delete", own()));
  await flush();
  expect(api.deleteMySkillReview).toHaveBeenCalledWith("pdf-tools");
  expect(toast.success).toHaveBeenCalledWith("Review deleted");
});

test("not installed: no form, a reason; a hidden own review is marked", async () => {
  api.listSkillReviews.mockResolvedValue(
    page({
      viewer: {
        canReview: false,
        reason: "not_installed",
        canReply: false,
        ownReview: review("mine", { status: "hidden" }),
      },
    }),
  );
  await renderReviews();
  expect(own().textContent).toContain("Install the skill to review it.");
  expect(own().querySelector('[data-testid="skill-review-editor"]')).toBeNull();
  expect(
    own().querySelector('[data-testid="skill-review-own-hidden"]'),
  ).not.toBeNull();
  expect(own().textContent).toContain("Hidden");
  // Taking back what they wrote needs no install.
  expect(buttons("Delete", own())).toHaveLength(1);
});

test("the repository author replies, edits and deletes a reply", async () => {
  api.listSkillReviews.mockResolvedValue(
    page({
      items: [
        review("r1"),
        review("r2", {
          authorReply: { body: "Fixed", createdAt: "2026-09-21T00:00:00.000Z" },
        }),
      ],
      viewer: { canReview: false, reason: "not_installed", canReply: true },
    }),
  );
  api.saveSkillReviewReply.mockResolvedValue({
    review: review("r1", {
      authorReply: { body: "Thanks!", createdAt: "2026-09-22T00:00:00.000Z" },
    }),
  });
  api.deleteSkillReviewReply.mockResolvedValue({ review: review("r2") });
  await renderReviews();

  await click(button("Reply", item("r1")));
  const editor = item("r1").querySelector<HTMLElement>(
    '[data-testid="skill-review-reply-editor"]',
  )!;
  await act(async () =>
    typeInto(editor.querySelector("textarea")!, " Thanks! "),
  );
  await click(button("Save reply", editor));
  await flush();
  expect(api.saveSkillReviewReply).toHaveBeenCalledWith(
    "pdf-tools",
    "r1",
    "Thanks!",
  );
  expect(item("r1").textContent).toContain("Thanks!");
  expect(buttons("Edit reply", item("r1"))).toHaveLength(1);

  await click(button("Edit reply", item("r2")));
  expect(item("r2").querySelector("textarea")?.value).toBe("Fixed");
  await click(button("Cancel", item("r2")));
  await click(button("Delete reply", item("r2")));
  await flush();
  expect(api.deleteSkillReviewReply).toHaveBeenCalledWith("pdf-tools", "r2");
  expect(
    item("r2").querySelector('[data-testid="skill-review-author-reply"]'),
  ).toBeNull();
});

test("a market admin hides a review, which stays on screen to be shown again", async () => {
  api.isSkillMarketAdminViewer.mockResolvedValue(true);
  await renderReviews();
  await click(button("Hide", item("r1")));
  await flush();
  expect(api.setSkillReviewStatus).toHaveBeenCalledWith("r1", "hidden");
  expect(item("r1").textContent).toContain("Hidden");
  // The summary is read again, without replacing the list.
  expect(api.listSkillReviews).toHaveBeenLastCalledWith("pdf-tools", {
    sort: "newest",
    limit: 1,
  });
  await click(button("Show", item("r1")));
  await flush();
  expect(api.setSkillReviewStatus).toHaveBeenLastCalledWith("r1", "visible");
  expect(toast.success).toHaveBeenLastCalledWith("Review shown");
});

test("a skill whose reviews the viewer cannot read shows nothing; other failures offer a retry", async () => {
  api.listSkillReviews.mockRejectedValue({ status: 404 });
  await renderReviews();
  expect(container.querySelector('[data-testid="skill-reviews"]')).toBeNull();
  act(() => root.unmount());
  container.remove();

  api.listSkillReviews.mockRejectedValueOnce({ status: 500 });
  api.listSkillReviews.mockResolvedValueOnce(page());
  await renderReviews();
  expect(container.textContent).toContain("Reviews could not be loaded.");
  await click(button("Try again"));
  await flush();
  expect(
    container.querySelectorAll('[data-testid="skill-review-item"]'),
  ).toHaveLength(2);
});
