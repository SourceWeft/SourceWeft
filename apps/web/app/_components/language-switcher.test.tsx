// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, test, vi } from "vitest";

import messages from "../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

const push = vi.fn();
const refresh = vi.fn();
let pathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
}));

vi.mock("../../lib/i18n/cookie", () => ({
  setLocaleCookie: vi.fn(),
}));

import { LanguageSwitcher } from "./language-switcher";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(locale: "en" | "zh-CN" | "zh-TW") {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;
  await act(async () => {
    createdRoot.render(
      <NextIntlClientProvider locale={locale} messages={intlMessages}>
        {createElement(LanguageSwitcher)}
      </NextIntlClientProvider>,
    );
  });
  return container;
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  push.mockClear();
  refresh.mockClear();
  pathname = "/";
});

// Regression for a bug found 2026-09-20: on a localized route, `/` and
// `/zh-CN` share the same root layout, so a bare `router.push` only swaps the
// leaf segment — `NextIntlClientProvider` (mounted in the root layout) never
// re-renders, and the chrome stays in the previous language until a hard
// reload. `router.refresh()` must run alongside `push` to invalidate the
// shared root layout too.
test("switching locale on a localized route pushes the prefixed URL and refreshes", async () => {
  const element = await render("en");
  const trigger = element.querySelector("button");
  assert.ok(trigger);
  await act(async () => {
    click(trigger);
  });
  const option = [...element.querySelectorAll('button[role="option"]')].find(
    (node) => node.textContent?.includes("简体中文"),
  );
  assert.ok(option);
  await act(async () => {
    click(option);
  });
  assert.equal(push.mock.calls.length, 1);
  assert.equal(push.mock.calls[0]?.[0], "/zh-CN");
  assert.equal(refresh.mock.calls.length, 1);
});

test("switching locale on a non-localized (app-tree) route only refreshes", async () => {
  pathname = "/dashboard";
  const element = await render("en");
  const trigger = element.querySelector("button");
  assert.ok(trigger);
  await act(async () => {
    click(trigger);
  });
  const option = [...element.querySelectorAll('button[role="option"]')].find(
    (node) => node.textContent?.includes("简体中文"),
  );
  assert.ok(option);
  await act(async () => {
    click(option);
  });
  assert.equal(push.mock.calls.length, 0);
  assert.equal(refresh.mock.calls.length, 1);
});

test("selecting the already-active locale is a no-op", async () => {
  const element = await render("en");
  const trigger = element.querySelector("button");
  assert.ok(trigger);
  await act(async () => {
    click(trigger);
  });
  const option = [...element.querySelectorAll('button[role="option"]')].find(
    (node) => node.textContent?.includes("English"),
  );
  assert.ok(option);
  await act(async () => {
    click(option);
  });
  assert.equal(push.mock.calls.length, 0);
  assert.equal(refresh.mock.calls.length, 0);
});
