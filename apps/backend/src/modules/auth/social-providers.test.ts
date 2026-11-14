import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildSocialProviders,
  nativeSignInConfig,
  type SocialProviderSettings,
} from "./social-providers";

const none: SocialProviderSettings = {
  googleSignInWebClientId: "",
  googleSignInWebClientSecret: "",
  googleOneTapClientId: "",
  googleMobileClientId: "",
  googleIosClientId: "",
  githubClientId: "",
  githubClientSecret: "",
  appleAppBundleId: "",
};
const googleWeb = {
  googleSignInWebClientId: "web.apps.googleusercontent.com",
  googleSignInWebClientSecret: "web-secret",
};

test("nothing is configured by default", () => {
  assert.deepEqual(buildSocialProviders(none), {});
  assert.deepEqual(nativeSignInConfig(none), {
    apple: false,
    googleIosClientId: null,
  });
});

test("Google keeps a single client id until another audience is configured", () => {
  assert.deepEqual(buildSocialProviders({ ...none, ...googleWeb }), {
    google: {
      clientId: "web.apps.googleusercontent.com",
      clientSecret: "web-secret",
      prompt: "select_account",
    },
  });
});

test("the iOS Google client is accepted as one more ID-token audience, after the web client", () => {
  const settings = {
    ...none,
    ...googleWeb,
    googleOneTapClientId: "web.apps.googleusercontent.com",
    googleMobileClientId: "android.apps.googleusercontent.com",
    googleIosClientId: "ios.apps.googleusercontent.com",
  };
  assert.deepEqual(buildSocialProviders(settings).google, {
    clientId: [
      "web.apps.googleusercontent.com",
      "android.apps.googleusercontent.com",
      "ios.apps.googleusercontent.com",
    ],
    clientSecret: "web-secret",
    prompt: "select_account",
  });
  assert.equal(
    nativeSignInConfig(settings).googleIosClientId,
    "ios.apps.googleusercontent.com",
  );
});

test("an iOS Google client without the Google provider is neither accepted nor offered", () => {
  for (const partial of [
    {},
    { googleSignInWebClientId: "web.apps.googleusercontent.com" },
    { googleSignInWebClientSecret: "web-secret" },
  ]) {
    const settings = {
      ...none,
      ...partial,
      googleIosClientId: "ios.apps.googleusercontent.com",
    };
    assert.equal(buildSocialProviders(settings).google, undefined);
    assert.equal(nativeSignInConfig(settings).googleIosClientId, null);
  }
});

test("Apple is configured for native identity tokens only, with the bundle id as the audience", () => {
  const settings = { ...none, appleAppBundleId: "nicelab.sourceweft.mobile" };
  assert.deepEqual(buildSocialProviders(settings), {
    apple: {
      clientId: "nicelab.sourceweft.mobile",
      appBundleIdentifier: "nicelab.sourceweft.mobile",
    },
  });
  assert.deepEqual(nativeSignInConfig(settings), {
    apple: true,
    googleIosClientId: null,
  });
});

test("Apple does not depend on, or enable, any other provider", () => {
  const settings = {
    ...none,
    ...googleWeb,
    githubClientId: "github-id",
    githubClientSecret: "github-secret",
    appleAppBundleId: "nicelab.sourceweft.mobile",
  };
  assert.deepEqual(Object.keys(buildSocialProviders(settings)).sort(), [
    "apple",
    "github",
    "google",
  ]);
  assert.deepEqual(
    Object.keys(
      buildSocialProviders({ ...settings, appleAppBundleId: "" }),
    ).sort(),
    ["github", "google"],
  );
});

test("GitHub needs both its id and its secret", () => {
  assert.deepEqual(
    buildSocialProviders({ ...none, githubClientId: "github-id" }),
    {},
  );
  assert.deepEqual(
    buildSocialProviders({
      ...none,
      githubClientId: "github-id",
      githubClientSecret: "github-secret",
    }).github,
    {
      clientId: "github-id",
      clientSecret: "github-secret",
      scope: ["read:user", "user:email"],
    },
  );
});
