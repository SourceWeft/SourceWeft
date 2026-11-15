// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  sso: vi.fn(),
  navigate: vi.fn(),
  localization: {
    signInWithSso: "Sign in with SSO",
    ssoTitle: "Single sign-on",
    ssoDescription:
      "Enter your work email to continue with your company's sign-in.",
    workEmail: "Work email",
    continue: "Continue",
    backToSignIn: "Back to sign in",
  },
}));

vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    authClient: { signIn: { sso: state.sso } },
    baseURL: "https://app.test",
    redirectTo: "/dashboard",
    basePaths: { auth: "/auth" },
    viewPaths: { auth: { signIn: "sign-in" } },
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

beforeEach(() => {
  state.sso.mockReset();
  state.navigate.mockReset();
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

test("does not sign in when the email is empty", async () => {
  const { container } = await mount(createElement(SsoSignIn));
  button("Continue", container).click();
  await flush();

  assert.equal(state.sso.mock.calls.length, 0);
});
