// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import zhCNMessages from "../../../../../messages/zh-CN.json";

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
import {
  type IntlOptions,
  messages,
  mountWithIntl,
  unmountAll,
} from "@/test/react";

type IntlMessages = IntlOptions["messages"];
const catalogs: Record<string, IntlMessages> = {
  en: messages,
  "zh-CN": zhCNMessages as IntlMessages,
};

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

// The page provides next-intl, in the visitor's language.
async function render(node: ReactNode, locale = "en") {
  ({ container } = await mountWithIntl(node, {
    locale,
    messages: catalogs[locale],
  }));
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
  await render(
    <PublicSkillReport slug="gh-a-b-pdf" signedIn locale="zh-CN" />,
    "zh-CN",
  );
  expect(container.textContent).toContain(
    zhCNMessages.dashboardSkillReports.button.title,
  );
  expect(field("reason")).toBeNull();
  await open();
  expect(document.body.textContent).toContain(
    zhCNMessages.publicSkills.community.report.description,
  );
  expect(field("reason")).not.toBeNull();
});

test("in English: the button, and the dialog naming SourceWeft's admins", async () => {
  await render(<PublicSkillReport slug="gh-a-b-pdf" signedIn locale="en" />);
  expect(container.textContent).toContain("Report this skill");
  await open();
  expect(document.body.textContent).toContain(
    "Tell the SourceWeft market admins about a problem with this skill",
  );
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
