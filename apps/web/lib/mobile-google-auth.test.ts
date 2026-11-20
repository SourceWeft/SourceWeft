import { afterEach, expect, test, vi } from "vitest";

vi.mock("./auth-client", () => ({ authClient: {} }));
const { logSignInFailure } = vi.hoisted(() => ({
  logSignInFailure: vi.fn(() => Promise.resolve()),
}));
vi.mock("./native-bridge", () => ({ nativeBridge: { logSignInFailure } }));

import { getMobileGoogleSignInError } from "./mobile-google-auth";

afterEach(() => {
  vi.restoreAllMocks();
  logSignInFailure.mockClear();
});

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
  // The SDK text goes to the device log, where it can be read from a Mac.
  expect(logSignInFailure).toHaveBeenCalledWith("google", raw);
});

test("a cancelled Google sign-in shows nothing and logs nothing", () => {
  expect(
    getMobileGoogleSignInError(
      new Error("The user canceled the sign-in flow."),
    ),
  ).toBeNull();
  expect(logSignInFailure).not.toHaveBeenCalled();
});

test("a failure the device log cannot take still shows the plain sentence", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  logSignInFailure.mockImplementationOnce(() =>
    Promise.reject(new Error("no bridge")),
  );
  expect(getMobileGoogleSignInError({ code: 7 })).toBe(
    "Unable to sign in with Google. Try again or use email.",
  );
  expect(logSignInFailure).toHaveBeenCalledWith("google", '{"code":7}');
});
