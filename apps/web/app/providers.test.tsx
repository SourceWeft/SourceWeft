// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  setTheme: vi.fn(),
  userId: "user-1" as string | undefined,
  settings: { appearance: { theme: "system", language: "system" as string } },
  cookie: "" as string,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: state.refresh }),
  usePathname: () => "/dashboard",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: state.setTheme }),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: state.userId ? { user: { id: state.userId } } : null,
    }),
  },
}));

vi.mock("../lib/sdk", () => ({
  userSettingsClient: {
    getSettings: () => Promise.resolve({ settings: state.settings }),
  },
}));

// A real cookie jar, not a mock: `getLocaleCookie`/`setLocaleCookie`/
// `clearLocaleCookie` are exercised for real against `document.cookie`, since
// the behavior under test is precisely "does the pinned cookie end up
// matching the account, and is a refresh triggered exactly when it must be".

import { UserSettingsSync } from "./providers";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

async function render(locale: "en" | "zh-CN" | "zh-TW") {
  const { container } = await mountWithIntl(createElement(UserSettingsSync), {
    locale,
  });
  return container;
}

function clearCookieJar() {
  document.cookie = "sw_locale=; path=/; max-age=0";
}

afterEach(async () => {
  await unmountAll();
  state.refresh.mockClear();
  state.setTheme.mockClear();
  state.userId = "user-1";
  state.settings = { appearance: { theme: "system", language: "system" } };
  clearCookieJar();
});

// Regression for a gap found 2026-09-20: on a brand-new browser/device (no
// `sw_locale` cookie yet), the very first SSR render used Accept-Language,
// not the account setting — signing in there previously only corrected the
// cookie for the *next* navigation, so the account's explicit language did
// not "follow the person" on that device's first load. It must self-correct
// on the current render too, or the account setting isn't really the one
// long-term truth across devices.
test("a fresh device with no cookie self-corrects to the account's explicit language", async () => {
  clearCookieJar();
  state.settings = { appearance: { theme: "system", language: "zh-CN" } };
  // Rendered as "en" (e.g. what Accept-Language negotiated) while the
  // account says zh-CN — a real mismatch a new device would hit.
  await render("en");
  await flush();
  assert.equal(state.refresh.mock.calls.length, 1);
  assert.match(document.cookie, /sw_locale=zh-CN/);
});

test("a returning visitor whose render already matches the account does not refresh", async () => {
  clearCookieJar();
  state.settings = { appearance: { theme: "system", language: "zh-CN" } };
  await render("zh-CN");
  await flush();
  assert.equal(state.refresh.mock.calls.length, 0);
  assert.match(document.cookie, /sw_locale=zh-CN/);
});

test('"system" clears a stale pinned cookie and refreshes, since behavior can change', async () => {
  document.cookie = "sw_locale=zh-TW; path=/";
  state.settings = { appearance: { theme: "system", language: "system" } };
  await render("zh-TW");
  await flush();
  assert.equal(state.refresh.mock.calls.length, 1);
  assert.doesNotMatch(document.cookie, /sw_locale=zh-TW/);
});

test('"system" with no pinned cookie is already correct and does not refresh', async () => {
  clearCookieJar();
  state.settings = { appearance: { theme: "system", language: "system" } };
  await render("en");
  await flush();
  assert.equal(state.refresh.mock.calls.length, 0);
});

test("signed-out visitors are left alone entirely", async () => {
  state.userId = undefined;
  clearCookieJar();
  await render("en");
  await flush();
  assert.equal(state.refresh.mock.calls.length, 0);
  assert.equal(state.setTheme.mock.calls.length, 0);
});
