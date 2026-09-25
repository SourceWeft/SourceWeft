// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { SkillReview } from "../../../../../lib/skill-reviews";
import { SkillReviewItem } from "./skill-review-item";
import { SkillReviewStarPicker, SkillReviewStars } from "./skill-review-stars";
import { SkillReviewSummary } from "./skill-review-summary";
import zhCNMessages from "../../../../../messages/zh-CN.json";
import { type IntlOptions, mountWithIntl, unmountAll } from "@/test/react";

// The presentational parts: they render from data alone, with no fetch.

let container: HTMLDivElement;

afterEach(unmountAll);

async function render(node: ReactNode) {
  ({ container } = await mountWithIntl(node));
}

const now = Date.parse("2026-09-22T12:00:00.000Z");
const review: SkillReview = {
  id: "rev_1",
  rating: 4,
  body: "Solid.\nNeeds docs.",
  status: "visible",
  version: "1.2.0",
  reviewer: { name: "Ada Lovelace", image: null },
  authorReply: {
    body: "Docs are coming.",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
};

test("the summary: average to one decimal, count, one bar per star", async () => {
  await render(
    <SkillReviewSummary
      summary={{
        count: 4,
        average: 3.75,
        distribution: { "1": 1, "2": 0, "3": 0, "4": 1, "5": 2 },
      }}
    />,
  );
  const text = container.textContent ?? "";
  expect(text).toContain("3.8");
  expect(text).toContain("4 reviews");
  const bar = (stars: number) =>
    container.querySelector<HTMLElement>(
      `[data-testid="skill-review-bar-${stars}"]`,
    )!.style.width;
  expect(bar(5)).toBe("50%");
  expect(bar(4)).toBe("25%");
  expect(bar(2)).toBe("0%");
  expect(container.querySelector('[aria-label="5 stars: 2"]')).not.toBeNull();
});

test("an empty summary shows a dash and zero bars", async () => {
  await render(
    <SkillReviewSummary
      summary={{
        count: 0,
        average: null,
        distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
      }}
    />,
  );
  expect(container.textContent).toContain("—");
  expect(container.textContent).toContain("0 reviews");
});

test("stars are labelled with the rating", async () => {
  await render(<SkillReviewStars rating={1} />);
  expect(
    container.querySelector('[role="img"]')?.getAttribute("aria-label"),
  ).toBe("1 star");
});

test("the star picker reports the chosen rating", async () => {
  const onChange = vi.fn();
  await render(<SkillReviewStarPicker value={2} onChange={onChange} />);
  const radios =
    container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  expect(radios).toHaveLength(5);
  expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
  act(() => radios[4]!.click());
  expect(onChange).toHaveBeenCalledWith(5);
});

test("a review shows who, stars, text, version, when, and the author's reply", async () => {
  await render(<SkillReviewItem review={review} now={now} />);
  const text = container.textContent ?? "";
  expect(text).toContain("Ada Lovelace");
  expect(text).toContain("AL"); // the avatar's fallback
  expect(text).toContain("Solid.\nNeeds docs.");
  expect(text).toContain("Version 1.2.0");
  expect(text).toContain("2 days ago");
  expect(
    container.querySelector('[data-testid="skill-review-author-reply"]')
      ?.textContent,
  ).toContain("Docs are coming.");
  expect(container.textContent).not.toContain("Hidden");
});

test("in a zh-CN page the dates are relative in Chinese, never English", async () => {
  ({ container } = await mountWithIntl(
    <SkillReviewItem review={review} now={now} />,
    {
      locale: "zh-CN",
      messages: zhCNMessages as IntlOptions["messages"],
    },
  ));
  const times = [...container.querySelectorAll("time")].map(
    (node) => node.textContent,
  );
  expect(times).toEqual(["前天", "昨天"]);
  expect(container.textContent).not.toContain("ago");
});

test("a hidden review is marked; controls and a replacement reply slot in", async () => {
  await render(
    <SkillReviewItem
      review={{
        ...review,
        status: "hidden",
        reviewer: { name: null, image: null },
        version: null,
      }}
      now={now}
      actions={<button type="button">Act</button>}
      reply={<p>editing</p>}
    />,
  );
  const text = container.textContent ?? "";
  expect(text).toContain("Hidden");
  expect(text).toContain("Former user");
  expect(text).not.toContain("Version");
  expect(text).toContain("Act");
  expect(text).toContain("editing");
  expect(
    container.querySelector('[data-testid="skill-review-author-reply"]'),
  ).toBeNull();
});
