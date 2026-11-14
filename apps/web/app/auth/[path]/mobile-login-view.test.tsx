// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  platform: "ios",
  googleMobileClientId: "web.apps.googleusercontent.com",
  replace: vi.fn(),
  refresh: vi.fn(),
  getSession: vi.fn(),
  signInWithMobileApple: vi.fn(),
  signInWithMobileGoogle: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace, refresh: state.refresh }),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: { getSession: state.getSession },
}));

vi.mock("../../../lib/api-base-url", () => ({ apiBaseUrl: "http://api.test" }));

vi.mock("../../../lib/native-bridge", () => ({
  nativeBridge: {
    info: async () => ({ platform: state.platform }),
  },
}));

vi.mock("../../../lib/public-runtime-config", () => ({
  publicRuntimeConfig: () => ({
    googleMobileClientId: state.googleMobileClientId,
  }),
}));

vi.mock("../../../lib/mobile-apple-auth", () => ({
  signInWithMobileApple: state.signInWithMobileApple,
  getMobileAppleSignInError: (error: unknown) =>
    error instanceof Error ? error.message : null,
}));

vi.mock("../../../lib/mobile-google-auth", () => ({
  signInWithMobileGoogle: state.signInWithMobileGoogle,
  getMobileGoogleSignInError: (error: unknown) =>
    error instanceof Error ? error.message : null,
}));

vi.mock("../../../lib/analytics-events", () => ({
  trackAuthError: vi.fn(),
  trackLogin: vi.fn(),
  trackSignUp: vi.fn(),
}));

import { MobileLoginView } from "./mobile-login-view";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const IOS_CLIENT = "ios.apps.googleusercontent.com";

function answerAuthConfig(nativeSignIn: unknown, ok = true) {
  const fetchMock = vi.fn<(url: string) => Promise<unknown>>(async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => ({ nativeSignIn }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function button(label: string) {
  return [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
}

async function mount() {
  await mountWithIntl(createElement(MobileLoginView, { path: "sign-in" }));
  await flush();
  await flush();
}

beforeEach(() => {
  state.platform = "ios";
  state.getSession.mockResolvedValue({ data: null });
  state.signInWithMobileApple.mockReset();
  state.signInWithMobileGoogle.mockReset();
  state.replace.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

test("iOS offers Apple and Google when the API accepts both, and signs in with the iOS Google client", async () => {
  const fetchMock = answerAuthConfig({
    apple: true,
    googleIosClientId: IOS_CLIENT,
  });
  state.signInWithMobileGoogle.mockResolvedValue({});
  state.signInWithMobileApple.mockResolvedValue({});

  await mount();

  assert.equal(fetchMock.mock.calls[0]?.[0], "http://api.test/v1/auth/config");
  const apple = button("Continue with Apple");
  const google = button("Continue with Google");
  assert(apple && !apple.disabled, "Apple button is offered and enabled");
  assert(google && !google.disabled, "Google button is offered and enabled");

  google.click();
  await flush();
  assert.deepEqual(state.signInWithMobileGoogle.mock.calls, [[IOS_CLIENT]]);

  state.getSession.mockResolvedValue({ data: { session: { id: "s1" } } });
  apple.click();
  await flush();
  await flush();
  assert.equal(state.signInWithMobileApple.mock.calls.length, 1);
  assert.deepEqual(state.replace.mock.calls.at(-1), ["/dashboard/chat"]);
});

test("iOS shows no Google button without Sign in with Apple", async () => {
  answerAuthConfig({ apple: false, googleIosClientId: IOS_CLIENT });
  await mount();
  assert.equal(button("Continue with Google"), undefined);
  assert.equal(button("Continue with Apple"), undefined);
});

test("iOS falls back to email only when the API cannot be asked", async () => {
  answerAuthConfig(null, false);
  await mount();
  assert.equal(button("Continue with Google"), undefined);
  assert.equal(button("Continue with Apple"), undefined);
  assert(document.querySelector('input[type="email"]'), "email form remains");
});

test("Android keeps Google with the web build's client, never asks the API, and has no Apple button", async () => {
  state.platform = "android";
  const fetchMock = answerAuthConfig({
    apple: true,
    googleIosClientId: IOS_CLIENT,
  });
  state.signInWithMobileGoogle.mockResolvedValue({});

  await mount();

  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(button("Continue with Apple"), undefined);
  const google = button("Continue with Google");
  assert(google, "Google button is offered");
  google.click();
  await flush();
  assert.deepEqual(state.signInWithMobileGoogle.mock.calls, [
    ["web.apps.googleusercontent.com"],
  ]);
});
