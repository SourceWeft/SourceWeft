// @vitest-environment jsdom

import { expect, test } from "vitest";

import { authStaticPaths, organizationStaticPaths } from "./auth-ui-config";

// `app/auth/[path]/page.tsx` sets `dynamicParams = false`, so every auth route
// must be pre-generated from `authStaticPaths`. A missing segment 404s.
test("includes the SSO sign-in route segment", () => {
  expect(authStaticPaths).toContain("sso");
});

test("still includes the built-in sign-in route segment", () => {
  expect(authStaticPaths).toContain("sign-in");
});

// `app/organization/[path]/page.tsx` also sets `dynamicParams = false`, so the
// SSO organization tab's `path` must be pre-generated from the plugin's
// `organizationTabs`. A missing segment 404s.
test("includes the SSO organization tab route segment", () => {
  expect(organizationStaticPaths).toContain("sso");
});
