// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const GENERIC_ERROR = "Something went wrong. Please try again.";

const state = vi.hoisted(() => ({
  sso: vi.fn(),
  navigate: vi.fn(),
  redirectTo: "/dashboard",
  localization: {
    signInWithSso: "Sign in with SSO",
    ssoTitle: "Single sign-on",
    ssoDescription:
      "Enter your work email to continue with your company's sign-in.",
    workEmail: "Work email",
    continue: "Continue",
    backToSignIn: "Back to sign in",
    ssoEmailRequired: "Enter your work email address.",
    ssoRateLimited: "Too many attempts. Please wait a minute and try again.",
    ssoNoSetup: "No single sign-on is set up for this email address.",
  },
}));

vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    authClient: { signIn: { sso: state.sso } },
    baseURL: "https://app.test",
    redirectTo: state.redirectTo,
    basePaths: { auth: "/auth" },
    viewPaths: { auth: { signIn: "sign-in" } },
    localization: { errors: { generic: GENERIC_ERROR } },
    navigate: state.navigate,
    Link: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children: unknown;
    }) => createElement("a", { href, ...props }, children as never),
  }),
  useAuthPlugin: () => ({
    localization: state.localization,
    viewPaths: { auth: { sso: "sso" } },
  }),
}));

import { SsoSignIn } from "./sso-sign-in";
import { button, flush, mount, typeInto, unmountAll } from "@/test/react";

function setSearch(search: string) {
  window.history.replaceState({}, "", `/auth/sso${search}`);
}

function backToSignInLink(container: ParentNode) {
  return [...container.querySelectorAll("a")].find(
    (element) => element.textContent?.trim() === "Back to sign in",
  );
}

beforeEach(() => {
  state.sso.mockReset();
  state.navigate.mockReset();
  state.redirectTo = "/dashboard";
  setSearch("");
});

afterEach(async () => {
  await unmountAll();
});

test("submits the trimmed work email and signs in with SSO once", async () => {
  state.sso.mockResolvedValue({ error: null });
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input, "work email input is rendered");
  typeInto(input, "  a@acme.com  ");

  button("Continue", container).click();
  await flush();

  assert.equal(state.sso.mock.calls.length, 1);
  assert.deepEqual(state.sso.mock.calls[0]?.[0]?.email, "a@acme.com");
});

test("shows the backend error message and keeps the email editable", async () => {
  state.sso.mockResolvedValue({
    error: { message: "该邮箱未配置企业单点登录。" },
  });
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  assert(
    container.textContent?.includes("该邮箱未配置企业单点登录。"),
    "the localized backend message is shown",
  );
  const after = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(after && !after.disabled, "the email input stays editable");
  assert.equal(after.value, "a@acme.com");
});

test("shows the localized no-setup message when the backend error has no message", async () => {
  state.sso.mockResolvedValue({ error: { message: "" } });
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  assert(
    container.textContent?.includes(state.localization.ssoNoSetup),
    "the localized no-setup message is shown for an empty error body",
  );
});

test("maps a 429 to the localized rate-limit message, not the raw body", async () => {
  state.sso.mockResolvedValue({
    error: { status: 429, message: "Too many requests" },
  });
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  assert(container.textContent?.includes(state.localization.ssoRateLimited));
  assert(!container.textContent?.includes("Too many requests"));
});

test("maps a raw English plugin message to the localized no-setup message", async () => {
  state.sso.mockResolvedValue({
    error: { message: "providerId, orgId or domain is required" },
  });
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  assert(container.textContent?.includes(state.localization.ssoNoSetup));
  assert(
    !container.textContent?.includes("is required"),
    "no raw English plugin string is shown",
  );
});

test("shows the generic error and re-enables the form when sign-in throws", async () => {
  state.sso.mockRejectedValue(new Error("network boom"));
  const { container } = await mount(createElement(SsoSignIn));

  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  assert(
    container.textContent?.includes(GENERIC_ERROR),
    "the generic localized error is shown on an unexpected throw",
  );
  const submit = button("Continue", container);
  assert(submit && !submit.disabled, "the submit button is usable again");
  const after = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(after && !after.disabled, "the email input is usable again");
});

test("auto-starts with the organization slug and renders no email form", async () => {
  setSearch("?org=acme");
  state.sso.mockResolvedValue({ error: null });
  const { container } = await mount(createElement(SsoSignIn));
  await flush();

  assert.equal(state.sso.mock.calls.length, 1);
  assert.deepEqual(state.sso.mock.calls[0]?.[0]?.organizationSlug, "acme");
  assert.equal(
    container.querySelector('input[type="email"]'),
    null,
    "no email input while starting from an organization slug",
  );
});

test("auto-starts from ?org exactly once under StrictMode", async () => {
  setSearch("?org=acme");
  state.sso.mockResolvedValue({ error: null });
  await mount(createElement(StrictMode, null, createElement(SsoSignIn)));
  await flush();

  assert.equal(
    state.sso.mock.calls.length,
    1,
    "the organization auto-start fires once despite the double effect",
  );
  assert.deepEqual(state.sso.mock.calls[0]?.[0]?.organizationSlug, "acme");
});

test("shows an inline message and does not sign in when the email is empty", async () => {
  const { container } = await mount(createElement(SsoSignIn));
  button("Continue", container).click();
  await flush();

  assert.equal(state.sso.mock.calls.length, 0);
  assert(
    container.textContent?.includes(state.localization.ssoEmailRequired),
    "an inline validation message is shown instead of a silent no-op",
  );
});

test('shows an inline message for an address without "@"', async () => {
  const { container } = await mount(createElement(SsoSignIn));
  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "not-an-email");
  button("Continue", container).click();
  await flush();

  assert.equal(state.sso.mock.calls.length, 0);
  assert(container.textContent?.includes(state.localization.ssoEmailRequired));
});

test("keeps the submit button disabled after a successful response", async () => {
  state.sso.mockResolvedValue({ error: null });
  const { container } = await mount(createElement(SsoSignIn));
  const input = container.querySelector<HTMLInputElement>(
    'input[type="email"]',
  );
  assert(input);
  typeInto(input, "a@acme.com");
  button("Continue", container).click();
  await flush();

  const submit = button("Continue", container);
  assert(
    submit.disabled,
    "the button stays disabled until the browser navigates to the IdP",
  );
});

test("the back-to-sign-in link carries the redirect destination", async () => {
  state.redirectTo = "/dashboard/x";
  const { container } = await mount(createElement(SsoSignIn));

  const link = backToSignInLink(container);
  assert(link, "the back-to-sign-in link is rendered");
  const href = link.getAttribute("href") ?? "";
  assert(href.startsWith("/auth/sign-in"), "it points at the sign-in page");
  assert(
    href.includes("redirectTo=%2Fdashboard%2Fx"),
    "it carries the redirect destination",
  );
});

test("the back-to-sign-in link adds no redirect parameter without a destination", async () => {
  state.redirectTo = "";
  const { container } = await mount(createElement(SsoSignIn));

  const link = backToSignInLink(container);
  assert(link);
  assert.equal(link.getAttribute("href"), "/auth/sign-in");
});
