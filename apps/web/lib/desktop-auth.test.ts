// @vitest-environment jsdom

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  verify: vi.fn(),
  generate: vi.fn(),
  trackAuthError: vi.fn(),
  trackDesktopHandoffStarted: vi.fn(),
  trackLogin: vi.fn(),
  trackSignUp: vi.fn(),
}));

vi.mock("./auth-client", () => ({
  authClient: {
    oneTimeToken: { verify: state.verify, generate: state.generate },
  },
}));

vi.mock("./analytics-events", () => ({
  trackAuthError: state.trackAuthError,
  trackDesktopHandoffStarted: state.trackDesktopHandoffStarted,
  trackLogin: state.trackLogin,
  trackSignUp: state.trackSignUp,
}));

import {
  buildDesktopSignInPath,
  buildDesktopWebAuthUrl,
  createDesktopHandoffLink,
  DesktopHandoffError,
  getPendingDesktopAuth,
  handleDesktopAuthDeepLink,
  setPendingDesktopAuth,
} from "./desktop-auth";

const STATE = "0b4f9d1c-6a0e-4a53-9a7e-5f0f8a2c1d3e";
const DESKTOP_ERROR = { action: "login", method: "desktop", surface: "desktop" };

function deepLink(params: Record<string, string>) {
  const url = new URL("sourceweft://auth/complete");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function startPendingSignIn(state = STATE) {
  setPendingDesktopAuth({ loginUrl: "https://app.test/auth", state });
}

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  for (const mock of Object.values(state)) {
    mock.mockReset();
  }
});

test("sign-in opens the completion page directly", () => {
  const url = buildDesktopWebAuthUrl({
    path: "/auth/sign-in",
    search: "?desktop=1&redirectTo=/elsewhere",
    state: STATE,
    webBaseUrl: "https://app.test/",
  });

  assert.equal(url, `https://app.test/auth/desktop-complete?state=${STATE}`);
});

test("other auth paths return to the completion page afterwards", () => {
  const url = new URL(
    buildDesktopWebAuthUrl({
      path: "auth/sign-up",
      search: "?invite=abc&redirectTo=/elsewhere",
      state: STATE,
      webBaseUrl: "https://app.test",
    }),
  );

  assert.equal(url.origin, "https://app.test");
  assert.equal(url.pathname, "/auth/sign-up");
  assert.equal(url.searchParams.get("invite"), "abc");
  assert.equal(
    url.searchParams.get("redirectTo"),
    `/auth/desktop-complete?state=${STATE}`,
  );
  assert.equal(url.searchParams.has("desktop"), false);
});

test("the sign-in path returns to the completion page for the same state", () => {
  const url = new URL(buildDesktopSignInPath(STATE), "https://app.test");

  assert.equal(url.pathname, "/auth/sign-in");
  assert.equal(
    url.searchParams.get("redirectTo"),
    `/auth/desktop-complete?state=${STATE}`,
  );
});

test("ignores links that are not desktop sign-in links", async () => {
  startPendingSignIn();

  assert.equal(
    await handleDesktopAuthDeepLink({ url: "sourceweft://open/thread?id=1" }),
    false,
  );
  assert.equal(
    await handleDesktopAuthDeepLink({ url: "https://app.test/auth/complete" }),
    false,
  );
  assert.equal(await handleDesktopAuthDeepLink({ url: "not a url" }), false);
  assert.equal(state.verify.mock.calls.length, 0);
});

test("drops a sign-in link whose state this app did not start", async () => {
  startPendingSignIn();
  const onError = vi.fn();
  const onSuccess = vi.fn();

  const handled = await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "someone-elses-token", state: "another-state" }),
    onError,
    onSuccess,
  });

  assert.equal(handled, true);
  assert.equal(state.verify.mock.calls.length, 0);
  assert.equal(onError.mock.calls.length, 0);
  assert.equal(onSuccess.mock.calls.length, 0);
  assert.equal(state.trackAuthError.mock.calls.length, 0);
  assert.equal(getPendingDesktopAuth().state, STATE);
});

test("drops a sign-in link when no sign-in is pending", async () => {
  const handled = await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "token", state: STATE }),
  });

  assert.equal(handled, true);
  assert.equal(state.verify.mock.calls.length, 0);
});

test("drops a sign-in link once the pending sign-in has expired", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
  startPendingSignIn();
  vi.setSystemTime(new Date("2026-09-28T00:11:00Z"));

  await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "token", state: STATE }),
  });

  assert.equal(state.verify.mock.calls.length, 0);
  assert.equal(getPendingDesktopAuth().state, null);
});

test("reports a sign-in link without a token", async () => {
  startPendingSignIn();
  const onError = vi.fn();

  await handleDesktopAuthDeepLink({
    url: deepLink({ state: STATE }),
    onError,
  });

  assert.deepEqual(onError.mock.calls, [["missing-token"]]);
  assert.deepEqual(state.trackAuthError.mock.calls, [[DESKTOP_ERROR]]);
  assert.equal(state.verify.mock.calls.length, 0);
});

test("keeps the pending sign-in when the token is rejected", async () => {
  startPendingSignIn();
  state.verify.mockResolvedValue({
    data: null,
    error: { message: "Invalid token" },
  });
  const onError = vi.fn();
  const onSuccess = vi.fn();

  await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "expired-token", state: STATE }),
    onError,
    onSuccess,
  });

  assert.deepEqual(onError.mock.calls, [["verification-failed"]]);
  assert.equal(onSuccess.mock.calls.length, 0);
  assert.deepEqual(state.trackAuthError.mock.calls, [[DESKTOP_ERROR]]);
  assert.equal(state.trackLogin.mock.calls.length, 0);
  assert.equal(getPendingDesktopAuth().state, STATE);
});

test("signs in an existing account and reports a desktop login", async () => {
  startPendingSignIn();
  state.verify.mockResolvedValue({
    data: {
      session: { id: "session-1" },
      user: { id: "user-1", createdAt: "2025-01-01T00:00:00.000Z" },
    },
    error: null,
  });
  const onSuccess = vi.fn();

  const handled = await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "one-time-token", state: STATE }),
    onSuccess,
  });

  assert.equal(handled, true);
  assert.deepEqual(state.verify.mock.calls, [[{ token: "one-time-token" }]]);
  assert.equal(onSuccess.mock.calls.length, 1);
  assert.deepEqual(state.trackLogin.mock.calls, [["desktop"]]);
  assert.equal(state.trackSignUp.mock.calls.length, 0);
  assert.equal(getPendingDesktopAuth().state, null);
});

test("reports a desktop sign-up for an account created just now", async () => {
  startPendingSignIn();
  state.verify.mockResolvedValue({
    data: {
      session: { id: "session-1" },
      user: { id: "user-1", createdAt: new Date().toISOString() },
    },
    error: null,
  });

  await handleDesktopAuthDeepLink({
    url: deepLink({ ott: "one-time-token", state: STATE }),
  });

  assert.deepEqual(state.trackSignUp.mock.calls, [["desktop"]]);
  assert.equal(state.trackLogin.mock.calls.length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const verifiedSession = {
  data: {
    session: { id: "session-1" },
    user: { id: "user-1", createdAt: "2025-01-01T00:00:00.000Z" },
  },
  error: null,
};

test("redeems overlapping handoffs once and ignores replays after success", async () => {
  startPendingSignIn();
  const verification = deferred<typeof verifiedSession>();
  state.verify.mockReturnValueOnce(verification.promise).mockResolvedValue({
    data: null,
    error: { message: "Invalid token" },
  });
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const input = {
    url: deepLink({ ott: "one-time-token", state: STATE }),
    onSuccess,
    onError,
  };

  const first = handleDesktopAuthDeepLink(input);
  const duplicate = handleDesktopAuthDeepLink(input);
  verification.resolve(verifiedSession);
  await Promise.all([first, duplicate]);
  await handleDesktopAuthDeepLink(input);

  assert.equal(state.verify.mock.calls.length, 1);
  assert.equal(onSuccess.mock.calls.length, 1);
  assert.equal(onError.mock.calls.length, 0);
  assert.equal(state.trackAuthError.mock.calls.length, 0);
  assert.deepEqual(state.trackLogin.mock.calls, [["desktop"]]);
  assert.equal(getPendingDesktopAuth().state, null);
});

test("does not start another verification for a fresh token during the same handoff", async () => {
  startPendingSignIn();
  const verification = deferred<typeof verifiedSession>();
  state.verify.mockReturnValue(verification.promise);
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const first = handleDesktopAuthDeepLink({
    url: deepLink({ ott: "first-token", state: STATE }),
    onSuccess,
    onError,
  });
  const second = handleDesktopAuthDeepLink({
    url: deepLink({ ott: "new-token", state: STATE }),
    onSuccess,
    onError,
  });
  verification.resolve(verifiedSession);
  await Promise.all([first, second]);

  assert.deepEqual(state.verify.mock.calls, [[{ token: "first-token" }]]);
  assert.equal(onSuccess.mock.calls.length, 1);
  assert.equal(onError.mock.calls.length, 0);
});

for (const failureKind of ["rejected-token", "network-error"] as const) {
  test(`reports ${failureKind} once and allows a fresh-token retry`, async () => {
    startPendingSignIn();
    const verification = deferred<{
      data: null;
      error: { message: string };
    }>();
    state.verify.mockReturnValue(verification.promise);
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const input = {
      url: deepLink({ ott: "failed-token", state: STATE }),
      onError,
      onSuccess,
    };
    const pending = Promise.allSettled([
      handleDesktopAuthDeepLink(input),
      handleDesktopAuthDeepLink(input),
    ]);
    if (failureKind === "network-error") {
      verification.reject(new Error("Network unavailable"));
    } else {
      verification.resolve({ data: null, error: { message: "Invalid token" } });
    }
    assert.deepEqual(await pending, [
      { status: "fulfilled", value: true },
      { status: "fulfilled", value: true },
    ]);
    assert.equal(state.verify.mock.calls.length, 1);
    assert.deepEqual(onError.mock.calls, [["verification-failed"]]);
    assert.deepEqual(state.trackAuthError.mock.calls, [[DESKTOP_ERROR]]);
    assert.equal(onSuccess.mock.calls.length, 0);
    assert.equal(getPendingDesktopAuth().state, STATE);

    state.verify.mockResolvedValue(verifiedSession);
    await handleDesktopAuthDeepLink({
      ...input,
      url: deepLink({ ott: "fresh-token", state: STATE }),
    });
    assert.equal(state.verify.mock.calls.length, 2);
    assert.equal(onSuccess.mock.calls.length, 1);
    assert.equal(onError.mock.calls.length, 1);
    assert.equal(getPendingDesktopAuth().state, null);
  });
}

test("builds the handoff deep link from a freshly issued token", async () => {
  state.generate.mockResolvedValue({
    data: { token: "one-time-token" },
    error: null,
  });

  const link = new URL(await createDesktopHandoffLink(STATE));

  assert.equal(link.protocol, "sourceweft:");
  assert.equal(link.hostname, "auth");
  assert.equal(link.pathname, "/complete");
  assert.equal(link.searchParams.get("ott"), "one-time-token");
  assert.equal(link.searchParams.get("state"), STATE);
  assert.equal(state.generate.mock.calls.length, 1);
  assert.equal(state.trackDesktopHandoffStarted.mock.calls.length, 1);
});

test("reports a handoff whose token could not be issued", async () => {
  state.generate.mockResolvedValue({
    data: null,
    error: { message: "Unauthorized" },
  });

  await assert.rejects(createDesktopHandoffLink(STATE), DesktopHandoffError);
  assert.deepEqual(state.trackAuthError.mock.calls, [[DESKTOP_ERROR]]);
  assert.equal(state.trackDesktopHandoffStarted.mock.calls.length, 0);
});
