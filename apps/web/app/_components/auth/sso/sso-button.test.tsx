// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  redirectTo: "/dashboard",
  localization: { signInWithSso: "Sign in with SSO" },
}));

vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    basePaths: { auth: "/auth" },
    redirectTo: state.redirectTo,
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

import { SsoButton } from "./sso-button";
import { mount, unmountAll } from "@/test/react";

beforeEach(() => {
  state.redirectTo = "/dashboard";
});

afterEach(async () => {
  await unmountAll();
});

test("links to /auth/sso and carries the redirect destination", async () => {
  state.redirectTo = "/dashboard/x";
  const { container } = await mount(createElement(SsoButton, {}));

  const link = container.querySelector("a");
  assert(link, "the SSO button renders a link");
  const href = link.getAttribute("href") ?? "";
  assert(href.startsWith("/auth/sso"), "it points at the SSO view");
  assert(
    href.includes("redirectTo=%2Fdashboard%2Fx"),
    "it carries the redirect destination",
  );
  assert(
    link.textContent?.includes("Sign in with SSO"),
    "it shows the SSO label",
  );
});

test("adds no redirect parameter when there is no destination", async () => {
  state.redirectTo = "";
  const { container } = await mount(createElement(SsoButton, {}));

  const link = container.querySelector("a");
  assert.equal(link?.getAttribute("href"), "/auth/sso");
});
