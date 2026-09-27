// @vitest-environment jsdom

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  createDesktopHandoffLink: vi.fn(),
  openDesktopDeepLink: vi.fn(),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: { getSession: state.getSession, signOut: state.signOut },
}));

vi.mock("../../../lib/desktop-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/desktop-auth")>()),
  createDesktopHandoffLink: state.createDesktopHandoffLink,
  openDesktopDeepLink: state.openDesktopDeepLink,
}));

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";
import { DesktopAuthCompleteClient } from "./desktop-complete-client";

const STATE = "0b4f9d1c-6a0e-4a53-9a7e-5f0f8a2c1d3e";
const DEEP_LINK = `sourceweft://auth/complete?ott=token&state=${STATE}`;

function signedIn() {
  state.getSession.mockResolvedValue({
    data: {
      session: { id: "session-1" },
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    },
  });
}

async function renderPage(search = `?state=${STATE}`) {
  window.history.replaceState({}, "", `/auth/desktop-complete${search}`);
  const view = await mountWithIntl(<DesktopAuthCompleteClient />);
  await flush(3);
  return view;
}

afterEach(async () => {
  await unmountAll();
  for (const mock of Object.values(state)) {
    mock.mockReset();
  }
});

test("opening the page shows the account without issuing a token", async () => {
  signedIn();

  const view = await renderPage();

  assert.match(view.container.textContent ?? "", /ada@example\.com/);
  assert.ok(button("Open SourceWeft desktop"));
  assert.equal(state.createDesktopHandoffLink.mock.calls.length, 0);
  assert.equal(state.openDesktopDeepLink.mock.calls.length, 0);
});

test("clicking open hands a fresh token to the desktop app", async () => {
  signedIn();
  state.createDesktopHandoffLink.mockResolvedValue(DEEP_LINK);
  await renderPage();

  await click(button("Open SourceWeft desktop"));
  await flush(3);

  assert.deepEqual(state.createDesktopHandoffLink.mock.calls, [[STATE]]);
  assert.deepEqual(state.openDesktopDeepLink.mock.calls, [[DEEP_LINK]]);

  // Retrying issues another token rather than reusing the first one.
  await click(button("Try again"));
  await flush(3);

  assert.equal(state.createDesktopHandoffLink.mock.calls.length, 2);
});

test("a failed handoff stays on the page with an error", async () => {
  signedIn();
  state.createDesktopHandoffLink.mockRejectedValue(new Error(""));
  const view = await renderPage();

  await click(button("Open SourceWeft desktop"));
  await flush(3);

  assert.equal(state.openDesktopDeepLink.mock.calls.length, 0);
  assert.match(
    view.container.textContent ?? "",
    /Unable to complete desktop sign-in\./,
  );
});

test("a link without state explains how to start again", async () => {
  const view = await renderPage("");

  assert.equal(state.getSession.mock.calls.length, 0);
  assert.match(view.container.textContent ?? "", /missing its state/);
});
