// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en.json";

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

import { PublicSkillReport } from "./public-skill-report";
import { publicReportCopy } from "./public-report-copy";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
// The shared form may read its text from next-intl; the page provides it.
const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={intlMessages}>
    {node}
  </NextIntlClientProvider>
);

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(withIntl(node)));
}

async function open() {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="public-skill-report-button"]',
      )!
      .click();
  });
}

/** Sets a form control's value the way React notices. */
function setValue(
  element: HTMLInputElement | HTMLSelectElement,
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
  document.body.querySelector<T>(`[name="${name}"]`);
const submitButton = () =>
  document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!;

test("the button is labeled in the page's language and opens the form", async () => {
  await render(<PublicSkillReport slug="gh-a-b-pdf" signedIn locale="zh-CN" />);
  expect(container.textContent).toContain(publicReportCopy("zh-CN").button);
  expect(field("reason")).toBeNull();
  await open();
  expect(document.body.textContent).toContain(
    publicReportCopy("zh-CN").description,
  );
  expect(field("reason")).not.toBeNull();
});

test("signed out, nothing is sent until an email is given", async () => {
  api.post.mockResolvedValue({ id: "r1", status: "open", createdAt: "" });
  await render(
    <PublicSkillReport slug="gh-a-b-pdf" signedIn={false} locale="en" />,
  );
  await open();
  await act(async () => {
    setValue(field<HTMLSelectElement>("reason")!, "copyright");
  });
  expect(field<HTMLInputElement>("contactEmail")!.required).toBe(true);
  expect(submitButton().disabled).toBe(true);
  await act(async () => {
    setValue(field<HTMLInputElement>("contactEmail")!, "owner@example.com");
  });
  await act(async () => {
    submitButton().click();
  });
  expect(api.post).toHaveBeenCalledWith("/v1/skills/gh-a-b-pdf/reports", {
    reason: "copyright",
    contactEmail: "owner@example.com",
  });
  expect(
    document.body.querySelector('[data-testid="skill-report-sent"]'),
  ).not.toBeNull();
});

test("signed in, the email is optional", async () => {
  api.post.mockResolvedValue({ id: "r1", status: "open", createdAt: "" });
  await render(<PublicSkillReport slug="gh-a-b-pdf" signedIn locale="en" />);
  await open();
  await act(async () => {
    setValue(field<HTMLSelectElement>("reason")!, "spam");
  });
  expect(field<HTMLInputElement>("contactEmail")!.required).toBe(false);
  await act(async () => {
    submitButton().click();
  });
  expect(api.post).toHaveBeenCalledWith("/v1/skills/gh-a-b-pdf/reports", {
    reason: "spam",
  });
});

test("every locale has its text, and an unknown one falls back to English", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const copy = publicReportCopy(locale);
    expect(copy.button && copy.title && copy.description).toBeTruthy();
  }
  expect(publicReportCopy("xx" as never)).toEqual(publicReportCopy("en"));
});
