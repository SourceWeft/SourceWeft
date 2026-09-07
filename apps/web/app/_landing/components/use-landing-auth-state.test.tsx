// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { test, vi } from "vitest";
import {
  useLandingAuthState,
  type LandingAuthState,
} from "./use-landing-auth-state";

const session = vi.hoisted(() => ({
  current: {
    isPending: true,
    data: null as { user: { name: string } } | null,
  },
}));
vi.mock("../../../lib/auth-client", () => ({
  authClient: { useSession: () => session.current },
}));

function AuthLabel({ initialState }: { initialState?: LandingAuthState }) {
  const state = useLandingAuthState(initialState);
  return createElement(
    "span",
    null,
    state.isPending
      ? "loading"
      : state.isSignedIn
        ? state.user?.name
        : "signed-out",
  );
}

for (const name of [null, "Signed-in user"]) {
  test(`session settling before hydration preserves server HTML (${name ?? "signed-out"})`, async () => {
    session.current = { isPending: true, data: null };
    const element = createElement(AuthLabel);
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    assert.equal(container.textContent, "loading");

    session.current = {
      isPending: false,
      data: name ? { user: { name } } : null,
    };
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, element, {
          onRecoverableError: (error) => errors.push(error),
        });
      });
      assert.deepEqual(errors, []);
      assert.equal(container.textContent, name ?? "signed-out");
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
}

test("a supplied server session hydrates consistently before the live signed-out state", async () => {
  const initialState = {
    isPending: false,
    isSignedIn: true,
    user: { name: "Server user" },
  };
  session.current = { isPending: true, data: null };
  const element = createElement(AuthLabel, { initialState });
  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  document.body.append(container);
  assert.equal(container.textContent, "Server user");

  session.current = { isPending: false, data: null };
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    assert.deepEqual(errors, []);
    assert.equal(container.textContent, "signed-out");
  } finally {
    await act(async () => root?.unmount());
    container.remove();
  }
});
