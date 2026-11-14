import { describe, expect, it } from "vitest";

import {
  parseNativeSignInConfig,
  resolveMobileSignInMethods,
} from "./mobile-sign-in-methods";

const IOS_CLIENT = "ios.apps.googleusercontent.com";
const ANDROID_CLIENT = "web.apps.googleusercontent.com";

describe("resolveMobileSignInMethods", () => {
  it("offers Apple and Google on iOS when the API accepts both", () => {
    expect(
      resolveMobileSignInMethods({
        platform: "ios",
        nativeSignIn: { apple: true, googleIosClientId: IOS_CLIENT },
        googleMobileClientId: ANDROID_CLIENT,
      }),
    ).toEqual({ apple: true, google: { clientId: IOS_CLIENT } });
  });

  it("never offers Google on iOS without Sign in with Apple", () => {
    expect(
      resolveMobileSignInMethods({
        platform: "ios",
        nativeSignIn: { apple: false, googleIosClientId: IOS_CLIENT },
        googleMobileClientId: ANDROID_CLIENT,
      }),
    ).toEqual({ apple: false, google: null });
  });

  it("offers Apple alone on iOS when the iOS Google client is not configured", () => {
    expect(
      resolveMobileSignInMethods({
        platform: "ios",
        nativeSignIn: { apple: true, googleIosClientId: null },
        googleMobileClientId: ANDROID_CLIENT,
      }),
    ).toEqual({ apple: true, google: null });
  });

  it("does not use the Android client on iOS, and offers nothing when the API's answer is missing", () => {
    expect(
      resolveMobileSignInMethods({
        platform: "ios",
        nativeSignIn: null,
        googleMobileClientId: ANDROID_CLIENT,
      }),
    ).toEqual({ apple: false, google: null });
  });

  it("keeps Android on the web build's client and never offers Apple there", () => {
    expect(
      resolveMobileSignInMethods({
        platform: "android",
        nativeSignIn: { apple: true, googleIosClientId: IOS_CLIENT },
        googleMobileClientId: ANDROID_CLIENT,
      }),
    ).toEqual({ apple: false, google: { clientId: ANDROID_CLIENT } });
  });
});

describe("parseNativeSignInConfig", () => {
  it("reads the API's answer", () => {
    expect(
      parseNativeSignInConfig({
        oneTapEnabled: true,
        nativeSignIn: { apple: true, googleIosClientId: ` ${IOS_CLIENT} ` },
      }),
    ).toEqual({ apple: true, googleIosClientId: IOS_CLIENT });
  });

  it("treats anything unexpected as not offered", () => {
    for (const body of [
      null,
      "nope",
      {},
      { nativeSignIn: null },
      { nativeSignIn: { apple: "true", googleIosClientId: 42 } },
      { nativeSignIn: { apple: 1, googleIosClientId: "  " } },
    ]) {
      expect(parseNativeSignInConfig(body)).toEqual({
        apple: false,
        googleIosClientId: null,
      });
    }
  });
});
