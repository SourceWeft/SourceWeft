// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import { afterEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string; createdAt?: Date | string } | null,
  trackSignUp: vi.fn(),
  trackLogin: vi.fn(),
}));

vi.mock("../auth-client", () => ({
  authClient: {
    useSession: () => ({ data: state.user ? { user: state.user } : null }),
  },
}));

vi.mock("./events", () => ({
  trackSignUp: state.trackSignUp,
  trackLogin: state.trackLogin,
}));

import { flush, mount, unmountAll } from "@/test/react";
import { recordAuthIntent } from "./auth-intent";
import { AuthAnalyticsTracker } from "./auth-tracker";

afterEach(async () => {
  await unmountAll();
  state.user = null;
  state.trackSignUp.mockReset();
  state.trackLogin.mockReset();
  localStorage.clear();
});

test("a new session with an intent tracks sign_up once", async () => {
  recordAuthIntent("google");
  state.user = { id: "user-1", createdAt: new Date() };
  const view = await mount(
    createElement(StrictMode, null, createElement(AuthAnalyticsTracker)),
  );
  await view.render(
    createElement(StrictMode, null, createElement(AuthAnalyticsTracker)),
  );
  await flush();
  assert.deepEqual(state.trackSignUp.mock.calls, [["google"]]);
  assert.equal(state.trackLogin.mock.calls.length, 0);
});

test("an existing account with an intent tracks login", async () => {
  recordAuthIntent("email");
  state.user = { id: "user-1", createdAt: "2025-01-01T00:00:00.000Z" };
  await mount(createElement(AuthAnalyticsTracker));
  await flush();
  assert.deepEqual(state.trackLogin.mock.calls, [["email"]]);
});

test("a session without an intent tracks nothing", async () => {
  state.user = { id: "user-1", createdAt: new Date() };
  await mount(createElement(AuthAnalyticsTracker));
  await flush();
  assert.equal(state.trackSignUp.mock.calls.length, 0);
  assert.equal(state.trackLogin.mock.calls.length, 0);
});
