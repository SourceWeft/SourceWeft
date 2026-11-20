import assert from "node:assert/strict";
import { test } from "vitest";
import {
  FALLBACK_WEB_AUTH_PAGE_CONFIG,
  parseWebAuthPageConfig,
  webSocialProviders,
} from "./web-sign-in-methods";

test("the Apple button is offered only when the server reports web Apple sign-in", () => {
  assert.deepEqual(webSocialProviders({ appleSignIn: false }), [
    "google",
    "github",
  ]);
  assert.deepEqual(webSocialProviders({ appleSignIn: true }), [
    "google",
    "github",
    "apple",
  ]);
});

test("web Apple sign-in is read from the API's webSignIn answer", () => {
  assert.deepEqual(
    parseWebAuthPageConfig({
      requireEmailVerification: false,
      webSignIn: { apple: true },
      // Native Apple sign-in is the iOS app's, never the web page's.
      nativeSignIn: { apple: true, googleIosClientId: null },
    }),
    { requireEmailVerification: false, appleSignIn: true },
  );
  assert.deepEqual(
    parseWebAuthPageConfig({
      requireEmailVerification: true,
      nativeSignIn: { apple: true, googleIosClientId: null },
    }),
    { requireEmailVerification: true, appleSignIn: false },
  );
});

test("an unexpected answer offers no Apple and keeps email verification", () => {
  for (const body of [
    null,
    "nope",
    {},
    { webSignIn: { apple: "true" } },
    { webSignIn: true },
  ]) {
    assert.deepEqual(parseWebAuthPageConfig(body), {
      requireEmailVerification: true,
      appleSignIn: false,
    });
  }
  assert.deepEqual(FALLBACK_WEB_AUTH_PAGE_CONFIG, {
    requireEmailVerification: true,
    appleSignIn: false,
  });
});
