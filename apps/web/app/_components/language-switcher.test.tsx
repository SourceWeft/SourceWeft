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

const state = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  pathname: "/",
  userId: undefined as string | undefined,
}));
const { push, refresh, updateSettings } = state;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
  usePathname: () => state.pathname,
}));

vi.mock("../../lib/i18n/cookie", () => ({
  setLocaleCookie: vi.fn(),
}));

vi.mock("../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: state.userId ? { user: { id: state.userId } } : null,
    }),
  },
}));

vi.mock("../../lib/sdk", () => ({
  userSettingsClient: { updateSettings: state.updateSettings },
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
  updateSettings.mockClear();
  state.pathname = "/";
  state.userId = undefined;
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
  // Signed out: no account to persist to, cookie-only per the existing mock.
  assert.equal(updateSettings.mock.calls.length, 0);
});

// A signed-in user reaches this switcher too (it's on marketing pages like
// /blog, not just the logged-out landing page). Their choice must follow
// them across devices — the account setting is the one long-term truth —
// not fork into a cookie-only, per-browser choice that a dashboard visit on
// another device would silently contradict.
test("switching locale while signed in also persists to the account", async () => {
  state.userId = "user-1";
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
  assert.equal(updateSettings.mock.calls.length, 1);
  assert.deepEqual(updateSettings.mock.calls[0]?.[0], {
    appearance: { language: "zh-CN" },
  });
});

test("switching locale while signed out does not touch the account", async () => {
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
  assert.equal(updateSettings.mock.calls.length, 0);
});

test("switching locale on a non-localized (app-tree) route only refreshes", async () => {
  state.pathname = "/dashboard";
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

test("language changes retain repeated search parameters, pagination and the fragment", async () => {
  state.pathname = "/skills";
  window.history.replaceState(
    {},
    "",
    "/skills?q=react&tag=a&tag=b&cursor=next%2Bpage#reviews",
  );
  const element = await render("en");
  await act(async () => click(element.querySelector("button")!));
  const option = [...element.querySelectorAll('button[role="option"]')].find(
    (node) => node.textContent?.includes("简体中文"),
  )!;
  await act(async () => click(option));
  assert.equal(
    push.mock.calls[0]?.[0],
    "/zh-CN/skills?q=react&tag=a&tag=b&cursor=next%2Bpage#reviews",
  );
  window.history.replaceState({}, "", "/");
});
