import { afterEach, expect, test, vi } from "vitest";

vi.mock("./auth-client", () => ({ authClient: {} }));
vi.mock("./native-bridge", () => ({ nativeBridge: {} }));

import { getMobileGoogleSignInError } from "./mobile-google-auth";

afterEach(() => vi.restoreAllMocks());

test("the Google SDK's own errors are logged, and the person sees a plain sentence", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const raw =
    "Your app is missing support for the following URL schemes: com.googleusercontent.apps.123-abc";
  const message = getMobileGoogleSignInError(new Error(raw));
  expect(message).toBe(
    "Unable to sign in with Google. Try again or use email.",
  );
  expect(message).not.toContain("URL scheme");
  expect(warn).toHaveBeenCalled();
});
