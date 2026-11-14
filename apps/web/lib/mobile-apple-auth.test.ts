import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInWithApple = vi.fn();
const signInSocial = vi.fn();
const signOut = vi.fn();
const fetchMock = vi.fn();

vi.mock("./native-bridge", () => ({
  nativeBridge: { signInWithApple },
}));
vi.mock("./auth-client", () => ({
  authClient: { signIn: { social: signInSocial }, signOut },
}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.stubGlobal("fetch", fetchMock);

const { createAppleNonce, getMobileAppleSignInError, signInWithMobileApple } =
  await import("./mobile-apple-auth");

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  signInWithApple.mockReset();
  signInSocial.mockReset();
  signOut.mockReset();
  signOut.mockResolvedValue({});
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
      authorizationCode: "apple-code",
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
      authorizationCode: "apple-code",
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

  it("hands the authorization code to the API after the session exists", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
      authorizationCode: "apple-code",
    });
    signInSocial.mockResolvedValue({ data: {} });

    await signInWithMobileApple();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/auth/apple/authorization-code");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init.body)).toEqual({ code: "apple-code" });
    expect(signInSocial.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!,
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out again when the API cannot keep the Apple token", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
      authorizationCode: "apple-code",
    });
    signInSocial.mockResolvedValue({ data: {} });
    fetchMock.mockResolvedValue(new Response("{}", { status: 502 }));

    await expect(signInWithMobileApple()).rejects.toThrow(
      /could not be completed/,
    );
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("signs out again when Apple gave no authorization code, without calling the API", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
    });
    signInSocial.mockResolvedValue({ data: {} });

    await expect(signInWithMobileApple()).rejects.toThrow(
      /could not be completed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("does not hand over the code when the API refused the identity token", async () => {
    signInWithApple.mockResolvedValue({
      identityToken: "apple.identity.token",
      authorizationCode: "apple-code",
    });
    signInSocial.mockResolvedValue({ error: { message: "Invalid token" } });

    await expect(signInWithMobileApple()).rejects.toThrow("Invalid token");
    expect(fetchMock).not.toHaveBeenCalled();
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
