// @vitest-environment jsdom

import { expect, test } from "vitest";

import { authStaticPaths } from "./auth-ui-config";

// `app/auth/[path]/page.tsx` sets `dynamicParams = false`, so every auth route
// must be pre-generated from `authStaticPaths`. A missing segment 404s.
test("includes the SSO sign-in route segment", () => {
  expect(authStaticPaths).toContain("sso");
});

test("still includes the built-in sign-in route segment", () => {
  expect(authStaticPaths).toContain("sign-in");
});
