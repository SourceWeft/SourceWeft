// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

type CallbackHooks = {
  onRequest: () => void;
  onSuccess: () => void;
  onError: (context: { error: unknown }) => void;
};

const state = vi.hoisted(() => ({
  pathname: "/auth/sign-in",
  search: "",
  replace: vi.fn(),
  refresh: vi.fn(),
  refetch: vi.fn(),
  getSession: vi.fn(),
  oneTap: vi.fn(),
  recordAuthIntent: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace, refresh: state.refresh }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: null,
      isPending: false,
      refetch: state.refetch,
    }),
    getSession: state.getSession,
    oneTap: state.oneTap,
  },
}));

vi.mock("../lib/google-one-tap-config", () => ({
  resolveGoogleOneTapConfig: () => ({
    active: true,
    enabled: true,
    clientId: "client-id",
    fedCmEnabled: false,
  }),
}));

vi.mock("../lib/api-base-url", () => ({ apiBaseUrl: "http://api.test" }));

vi.mock("../lib/analytics/auth-intent", () => ({
  recordAuthIntent: state.recordAuthIntent,
}));

vi.mock("sonner", () => ({ toast: { error: state.toastError } }));

import { GoogleOneTap } from "./google-one-tap";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const SIGNED_IN = { data: { session: { id: "s1" }, user: { id: "u1" } } };
const SIGNED_OUT = { data: null };

/** The prompt promise the component is waiting on, settled by each test. */
let prompt: { resolve: () => void; reject: (error: unknown) => void };

function overlay() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** Mount on a One Tap path and return the callback request's hooks. */
async function mountAndPrompt(): Promise<CallbackHooks> {
  await mountWithIntl(createElement(GoogleOneTap));
  await flush(5);
  assert.equal(state.oneTap.mock.calls.length, 1);
  return state.oneTap.mock.calls[0]![0].fetchOptions as CallbackHooks;
}

beforeEach(() => {
  state.pathname = "/auth/sign-in";
  state.search = "";
  state.refetch.mockResolvedValue(undefined);
  state.getSession.mockResolvedValue(SIGNED_IN);
  state.oneTap.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        prompt = { resolve, reject };
      }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ oneTapEnabled: true }),
    })),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(state)) {
    if (typeof mock === "function") mock.mockReset();
  }
});

test("shows nothing while the prompt is open or after it is dismissed", async () => {
  await mountAndPrompt();
  assert.equal(overlay(), null);

  await act(async () => prompt.resolve());
  await flush(5);

  assert.equal(overlay(), null);
  assert.equal(state.toastError.mock.calls.length, 0);
  assert.equal(state.replace.mock.calls.length, 0);
});

test("covers the page as soon as the credential callback starts", async () => {
  const hooks = await mountAndPrompt();
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();

  await act(async () => hooks.onRequest());

  const node = overlay();
  assert.ok(node, "overlay is shown");
  assert.equal(node.getAttribute("aria-modal"), "true");
  assert.match(node.textContent ?? "", /Signing in with Google/);
  // Focus leaves the form control, and Tab cannot walk back to it.
  assert.equal(document.activeElement, node);
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  node.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  field.remove();
});

test("keeps the overlay up until the session is confirmed, then redirects", async () => {
  let confirm!: (value: unknown) => void;
  state.getSession.mockReturnValue(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  const hooks = await mountAndPrompt();

  await act(async () => {
    hooks.onRequest();
    hooks.onSuccess();
  });
  await flush(5);

  assert.ok(overlay(), "still pending while the session is being confirmed");
  assert.equal(state.replace.mock.calls.length, 0);
  assert.equal(state.getSession.mock.calls.length, 1);
  assert.equal(state.refetch.mock.calls.length, 0);

  // The `useSession` refetch runs beside the navigation, never ahead of it.
  state.refetch.mockReturnValue(new Promise(() => {}));
  await act(async () => confirm(SIGNED_IN));
  await flush(5);

  assert.equal(state.refetch.mock.calls.length, 1);
  assert.deepEqual(state.replace.mock.calls, [["/dashboard"]]);
  assert.equal(state.refresh.mock.calls.length, 1);
  assert.deepEqual(state.recordAuthIntent.mock.calls, [["google_one_tap"]]);
  assert.equal(overlay(), null);
  assert.equal(state.toastError.mock.calls.length, 0);
});

test("redirects to a safe redirectTo target", async () => {
  state.search = "redirectTo=/dashboard/chat";
  const hooks = await mountAndPrompt();

  await act(async () => {
    hooks.onRequest();
    hooks.onSuccess();
  });
  await flush(5);

  assert.deepEqual(state.replace.mock.calls, [["/dashboard/chat"]]);
});

test("still redirects when the prompt settles before the callback finishes", async () => {
  const hooks = await mountAndPrompt();

  // Google reports `credential_returned` as a dismissal, which can resolve
  // the prompt promise ahead of the callback request.
  await act(async () => prompt.resolve());
  await act(async () => {
    hooks.onRequest();
    hooks.onSuccess();
  });
  await flush(5);

  assert.deepEqual(state.replace.mock.calls, [["/dashboard"]]);
});

test("clears the overlay and reports a rejected callback", async () => {
  const hooks = await mountAndPrompt();

  await act(async () => hooks.onRequest());
  assert.ok(overlay());
  await act(async () => hooks.onError({ error: { status: 400 } }));
  await act(async () => prompt.resolve());
  await flush(5);

  assert.equal(overlay(), null);
  assert.deepEqual(state.toastError.mock.calls, [
    ["Google sign-in failed. Please try again."],
  ]);
  assert.equal(state.replace.mock.calls.length, 0);
});

test("reports a callback request that never reached the server", async () => {
  const hooks = await mountAndPrompt();

  await act(async () => hooks.onRequest());
  await act(async () => prompt.reject(new TypeError("Failed to fetch")));
  await flush(5);

  assert.equal(overlay(), null);
  assert.deepEqual(state.toastError.mock.calls, [
    ["Google sign-in failed. Please try again."],
  ]);
});

test("stays quiet when the prompt itself is cancelled", async () => {
  await mountAndPrompt();

  await act(async () => prompt.reject(new Error("FedCM prompt was dismissed")));
  await flush(5);

  assert.equal(overlay(), null);
  assert.equal(state.toastError.mock.calls.length, 0);
});

test("reports a session that never becomes visible", async () => {
  vi.useFakeTimers();
  state.getSession.mockResolvedValue(SIGNED_OUT);
  const hooks = await mountAndPrompt();

  await act(async () => {
    hooks.onRequest();
    hooks.onSuccess();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  assert.equal(state.getSession.mock.calls.length, 3);
  assert.equal(overlay(), null);
  assert.deepEqual(state.toastError.mock.calls, [
    ["Signed in, but your session was not available. Please try again."],
  ]);
  assert.equal(state.replace.mock.calls.length, 0);
});
