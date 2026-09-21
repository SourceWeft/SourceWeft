// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@sourceweft/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sourceweft/sdk")>();
  return {
    ...actual,
    HttpClient: class {
      post = api.post;
      get = vi.fn();
    },
  };
});

import { skillReportBody } from "../../../../../lib/skill-reports";
import { SkillReportButton } from "./skill-report-button";
import { formatRetryWait, SkillReportForm } from "./skill-report-form";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

// React needs to know it is under test to flush effects inside act().
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(withIntl(node)));
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

/** Sets a form control's value the way React notices. */
function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

const field = <T extends Element>(name: string) =>
  document.body.querySelector<T & Element>(`[name="${name}"]`)!;

async function fill(input: {
  reason?: string;
  details?: string;
  email?: string;
}) {
  await act(async () => {
    if (input.reason)
      setValue(field<HTMLSelectElement>("reason"), input.reason);
    if (input.details !== undefined)
      setValue(field<HTMLTextAreaElement>("details"), input.details);
    if (input.email !== undefined)
      setValue(field<HTMLInputElement>("contactEmail"), input.email);
  });
}

async function submit() {
  await act(async () => {
    button("Send report")!.click();
  });
}

function httpError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
) {
  return new HttpClientError({
    status,
    statusText: "",
    code,
    message: code,
    details,
  });
}

test("the reason list has human labels and nothing is sent without one", async () => {
  await render(<SkillReportForm slug="gh-a-b-pdf" signedIn />);
  const options = [...field<HTMLSelectElement>("reason").options].map(
    (option) => option.textContent,
  );
  expect(options).toContain("Copyright or license violation");
  expect(options).toContain("Broken or does not work");
  expect(button("Send report")!.disabled).toBe(true);
});

test("a signed-in report posts the reason and details, without an empty email, and shows success", async () => {
  api.post.mockResolvedValue({ id: "r1", status: "open", createdAt: "" });
  await render(<SkillReportForm slug="gh-a-b-pdf" signedIn />);
  await fill({ reason: "copyright", details: "  Copied from my repo  " });
  await submit();
  expect(api.post).toHaveBeenCalledWith("/v1/skills/gh-a-b-pdf/reports", {
    reason: "copyright",
    details: "Copied from my repo",
  });
  expect(
    document.body.querySelector('[data-testid="skill-report-sent"]')
      ?.textContent,
  ).toContain("Report sent");
});

test("signed out, the email is required before the form can be sent", async () => {
  api.post.mockResolvedValue({ id: "r1", status: "open", createdAt: "" });
  await render(<SkillReportForm slug="gh-a-b-pdf" signedIn={false} />);
  await fill({ reason: "spam" });
  expect(button("Send report")!.disabled).toBe(true);
  await fill({ email: "me@example.com" });
  expect(button("Send report")!.disabled).toBe(false);
  await submit();
  expect(api.post.mock.calls[0]![1]).toEqual({
    reason: "spam",
    contactEmail: "me@example.com",
  });
});

test("a rate limit says when to try again; 400 and 404 have their own messages", async () => {
  await render(<SkillReportForm slug="gh-a-b-pdf" signedIn />);
  await fill({ reason: "spam" });
  const cases = [
    [
      httpError(429, "SKILL_REPORT_RATE_LIMITED", { retryAfterSeconds: 1800 }),
      "Try again in 30 minutes.",
    ],
    [httpError(400, "VALIDATION_ERROR"), "a reason is required"],
    [httpError(404, "NOT_FOUND"), "can no longer be reported"],
    [httpError(500, "INTERNAL"), "could not be sent"],
  ] as const;
  for (const [error, message] of cases) {
    api.post.mockRejectedValueOnce(error);
    await submit();
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain(message);
  }
  // Still the form: nothing was sent.
  expect(
    document.body.querySelector('[data-testid="skill-report-sent"]'),
  ).toBeNull();
});

test("details past 4000 characters are refused before sending", async () => {
  await render(<SkillReportForm slug="gh-a-b-pdf" signedIn />);
  await fill({ reason: "other", details: "a".repeat(4001) });
  expect(button("Send report")!.disabled).toBe(true);
  expect(document.body.textContent).toContain("under 4000 characters");
});

test("the report button opens the form in a dialog and a sent report can be closed", async () => {
  api.post.mockResolvedValue({ id: "r1", status: "open", createdAt: "" });
  await render(
    <SkillReportButton
      skillId="skill_1"
      catalogId="cat_1"
      slug="gh-a-b-pdf"
      workspaceId="ws_1"
    />,
  );
  expect(field("reason")).toBeNull();
  await act(async () => {
    button("Report")!.click();
  });
  expect(document.body.textContent).toContain("Report this skill");
  expect(document.body.textContent).toContain(
    "Optional. Only market admins see it.",
  );
  await fill({ reason: "broken" });
  await submit();
  expect(api.post).toHaveBeenCalledWith("/v1/skills/gh-a-b-pdf/reports", {
    reason: "broken",
  });
  await act(async () => {
    button("Close")!.click();
  });
  expect(document.body.textContent).not.toContain("Report sent");
});

test("helpers: the body drops blanks and the wait reads naturally", () => {
  expect(
    skillReportBody({ reason: "spam", details: " ", contactEmail: "" }),
  ).toEqual({ reason: "spam" });
  expect(skillReportBody({ reason: "spam", reviewId: "rev_1" })).toEqual({
    reason: "spam",
    reviewId: "rev_1",
  });
  const t = createTranslator({
    locale: "en",
    messages,
    namespace: "dashboardSkillReports",
  }) as unknown as Parameters<typeof formatRetryWait>[1];
  expect(formatRetryWait(null, t)).toBeNull();
  expect(formatRetryWait(1, t)).toBe("1 second");
  expect(formatRetryWait(45, t)).toBe("45 seconds");
  expect(formatRetryWait(1800, t)).toBe("30 minutes");
  expect(formatRetryWait(3 * 3600, t)).toBe("3 hours");
});
