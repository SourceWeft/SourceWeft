import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInWithApple = vi.fn();
const signInSocial = vi.fn();

vi.mock("./native-bridge", () => ({
  nativeBridge: { signInWithApple },
}));
vi.mock("./auth-client", () => ({
  authClient: { signIn: { social: signInSocial } },
}));

const { createAppleNonce, getMobileAppleSignInError, signInWithMobileApple } =
  await import("./mobile-apple-auth");

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  signInWithApple.mockReset();
  signInSocial.mockReset();
});

describe("createAppleNonce", () => {
  it("pairs a fresh random nonce with its SHA-256 in hex", async () => {
    const first = await createAppleNonce();
    const second = await createAppleNonce();
    expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hashedNonce).toBe(sha256Hex(first.nonce));
    expect(second.nonce).not.toBe(first.nonce);
  });
});

describe("signInWithMobileApple", () => {
  it("gives Apple the hashed nonce and the API the token with the nonce it was derived from", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
    });
    signInSocial.mockResolvedValue({ data: {} });

    await signInWithMobileApple();

    const [hashedNonce] = signInWithApple.mock.calls[0]!;
    const [request] = signInSocial.mock.calls[0]!;
    expect(request).toEqual({
      provider: "apple",
      callbackURL: "/dashboard",
      idToken: { token: "apple.identity.token", nonce: expect.any(String) },
    });
    expect(hashedNonce).toBe(sha256Hex(request.idToken.nonce));
    expect(hashedNonce).not.toBe(request.idToken.nonce);
  });

  it("passes the name along when Apple provides it", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
      givenName: "Ada",
      familyName: null,
    });
    signInSocial.mockResolvedValue({ data: {} });

    await signInWithMobileApple();

    expect(signInSocial.mock.calls[0]![0].idToken.user).toEqual({
      name: { firstName: "Ada", lastName: "" },
    });
  });

  it("does not call the API without an identity token", async () => {
    signInWithApple.mockResolvedValue({});
    await expect(signInWithMobileApple()).rejects.toThrow(/identity token/);
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("fails with the API's message when the token is refused", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
    });
    signInSocial.mockResolvedValue({ error: { message: "Invalid token" } });
    await expect(signInWithMobileApple()).rejects.toThrow("Invalid token");
  });
});

describe("getMobileAppleSignInError", () => {
  it("shows nothing when the person cancelled the sheet", () => {
    for (const error of [
      new Error("Sign in with Apple was cancelled"),
      "The operation was canceled.",
      { message: "Sign in with Apple was cancelled", code: "cancelled" },
    ]) {
      expect(getMobileAppleSignInError(error)).toBeNull();
    }
  });

  it("shows the reason otherwise, or a fallback when there is none", () => {
    expect(getMobileAppleSignInError(new Error("Invalid token"))).toBe(
      "Invalid token",
    );
    expect(getMobileAppleSignInError({})).toMatch(/Unable to sign in/);
  });
});
