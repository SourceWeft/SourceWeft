import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";
import {
  APPLE_SIGN_IN_ORIGIN,
  authTrustedOrigins,
  buildSocialProviders,
  nativeSignInConfig,
  webSignInConfig,
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
  appleServicesId: "",
  appleTeamId: "",
  appleKeyId: "",
  applePrivateKey: "",
};
const appleKey = {
  appleTeamId: "TEAM123456",
  appleKeyId: "KEY1234567",
  applePrivateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};

function jwtPayload(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
}
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
  assert.deepEqual(webSignInConfig(none), { apple: false });
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
  assert.deepEqual(webSignInConfig(settings), { apple: false });
});

test("web Apple sign-in runs as the Services ID and still accepts the iOS app's identity tokens", () => {
  const settings = {
    ...none,
    ...appleKey,
    appleAppBundleId: "nicelab.sourceweft.mobile",
    appleServicesId: "com.sourceweft.web",
  };
  const apple = buildSocialProviders(settings).apple as {
    clientId: string;
    clientSecret: string;
    appBundleIdentifier?: string;
  };
  assert.equal(apple.clientId, "com.sourceweft.web");
  assert.equal(apple.appBundleIdentifier, "nicelab.sourceweft.mobile");
  assert.deepEqual(webSignInConfig(settings), { apple: true });
  assert.equal(nativeSignInConfig(settings).apple, true);

  // The client secret is a JWT for the Services ID, signed again on each read
  // so it never outlives Apple's limit.
  const now = Math.floor(Date.now() / 1000);
  const claims = jwtPayload(apple.clientSecret);
  assert.equal(claims.sub, "com.sourceweft.web");
  assert.equal(claims.iss, "TEAM123456");
  assert.ok(claims.iat >= now - 5 && claims.exp <= now + 305);
});

test("web Apple sign-in without the iOS app offers no native Apple sign-in", () => {
  const settings = {
    ...none,
    ...appleKey,
    appleServicesId: "com.sourceweft.web",
  };
  const apple = buildSocialProviders(settings).apple as Record<
    string,
    unknown
  >;
  assert.equal(apple.clientId, "com.sourceweft.web");
  assert.equal("appBundleIdentifier" in apple, false);
  assert.deepEqual(webSignInConfig(settings), { apple: true });
  assert.equal(nativeSignInConfig(settings).apple, false);
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

test("Better Auth trusts Apple's origin only while web Apple sign-in is on", () => {
  const trustedOrigins = ["https://sourceweft.com"];
  assert.deepEqual(authTrustedOrigins({ ...none, trustedOrigins }), [
    "https://sourceweft.com",
  ]);
  // The iOS app alone posts no callback from Apple's site.
  assert.deepEqual(
    authTrustedOrigins({
      ...none,
      ...appleKey,
      appleAppBundleId: "nicelab.sourceweft.mobile",
      trustedOrigins,
    }),
    ["https://sourceweft.com"],
  );
  // Apple returns the web sign-in as a form POST from appleid.apple.com.
  const web = {
    ...none,
    ...appleKey,
    appleServicesId: "com.sourceweft.web",
    trustedOrigins,
  };
  assert.deepEqual(authTrustedOrigins(web), [
    "https://sourceweft.com",
    APPLE_SIGN_IN_ORIGIN,
  ]);
  // The shared list (also used for API CORS) is left as it was.
  assert.deepEqual(trustedOrigins, ["https://sourceweft.com"]);
  assert.deepEqual(
    authTrustedOrigins({ ...web, trustedOrigins: [APPLE_SIGN_IN_ORIGIN] }),
    [APPLE_SIGN_IN_ORIGIN],
  );
});
