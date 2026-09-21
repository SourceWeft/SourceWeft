// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import {
  formatResumeTime,
  SubmissionRateLimitNotice,
} from "./submission-rate-limit-notice";
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

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Parameters<typeof SubmissionRateLimitNotice>[0]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(withIntl(<SubmissionRateLimitNotice {...props} />)));
  return container.textContent ?? "";
}

const resumeAt = "2026-09-22T14:05:00.000Z";
const limited = {
  code: "GITHUB_RATE_LIMITED",
  message: "GitHub's rate limit was reached",
  resumeAt,
};

test("a queued, rate-limited import says when it resumes", () => {
  const time = formatResumeTime(resumeAt, "en")!;
  expect(time).toMatch(/\d{1,2}:\d{2}/);
  expect(render({ submission: { status: "queued", error: limited } })).toBe(
    `GitHub rate limit reached — resumes around ${time}`,
  );
});

test("without a usable time it still says it will resume", () => {
  expect(
    render({
      submission: {
        status: "queued",
        error: { ...limited, resumeAt: "not a date" },
      },
    }),
  ).toBe("GitHub rate limit reached — the import resumes shortly");
});

test("a failed one (its error already shows) and anything else render nothing", () => {
  expect(render({ submission: { status: "failed", error: limited } })).toBe("");
  act(() => root.unmount());
  container.remove();
  expect(
    render({
      submission: {
        status: "failed",
        error: { code: "REGISTRY_SUBMISSION_NOT_SKILL", message: "x" },
      },
    }),
  ).toBe("");
  act(() => root.unmount());
  container.remove();
  expect(render({ submission: { status: "queued", error: null } })).toBe("");
});

test("the time is the viewer's HH:MM", () => {
  expect(formatResumeTime(resumeAt, "en-GB")).toBe(
    new Date(resumeAt).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  expect(formatResumeTime(undefined)).toBeNull();
});
