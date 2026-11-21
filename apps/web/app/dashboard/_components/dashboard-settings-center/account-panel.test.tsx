// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, test, vi } from "vitest";

const deleteUser = vi.fn();
const signOut = vi.fn();

vi.mock("../../../../lib/auth-client", () => ({
  authClient: {
    deleteUser: () => deleteUser(),
    signOut: () => signOut(),
    updateUser: vi.fn(),
  },
}));
vi.mock("../../../../lib/local-host-session", () => ({
  disconnectLocalHostSession: vi.fn(async () => undefined),
}));
vi.mock("../../../../lib/user-settings", () => ({
  useUserSettings: () => ({ data: undefined }),
  useUpdateUserSettings: () => vi.fn(async () => undefined),
}));
vi.mock("../../../../lib/i18n/cookie", () => ({
  clearLocaleCookie: vi.fn(),
  setLocaleCookie: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

import { AccountPanel } from "./account-panel";
import { button, mountWithIntl, typeInto, unmountAll } from "@/test/react";

function render(layout?: "dialog" | "page") {
  return mountWithIntl(
    createElement(AccountPanel, {
      initials: "AL",
      layout,
      userEmail: "ada@example.com",
      userName: "Ada Lovelace",
    }),
  );
}

afterEach(async () => {
  await unmountAll();
  deleteUser.mockReset();
  signOut.mockReset();
});

test("the phone page layout centers the avatar and ends with the danger zone", async () => {
  const { container } = await render("page");
  const root = container.querySelector('[data-layout="page"]');
  assert.ok(root, "renders the page layout");

  // The avatar itself and a text action both open the file picker.
  assert.ok(
    container.querySelector('button[aria-label="Change avatar"]'),
    "the avatar is a labelled button",
  );
  assert.ok(button("Change avatar", container));
  assert.match(root.textContent ?? "", /ada@example\.com/);

  // Sign out comes before account deletion, which sits alone at the bottom.
  const dangerZone = container.querySelector(
    '[data-testid="account-danger-zone"]',
  );
  assert.ok(dangerZone);
  const signOutButton = button("Sign out", container);
  assert.ok(
    signOutButton.compareDocumentPosition(dangerZone) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const lastSection = root.lastElementChild;
  assert.ok(lastSection?.contains(dangerZone));
  const deleteButton = button("Delete account", dangerZone);
  assert.match(deleteButton.className, /\bw-full\b/);
});

test("the phone page layout shows a full-width save action once the name changes", async () => {
  const { container } = await render("page");
  assert.equal(button("Save changes", container), undefined);

  const input = container.querySelector<HTMLInputElement>("#display-name");
  assert.ok(input);
  assert.match(input.className, /\btext-base\b/, "16px so iOS does not zoom");
  await act(async () => typeInto(input, "Ada King"));

  const save = button("Save changes", container);
  assert.ok(save);
  assert.match(save.className, /\bw-full\b/);
});

test("the settings dialog keeps its side-by-side layout", async () => {
  const { container } = await render();
  assert.equal(container.querySelector('[data-layout="page"]'), null);
  assert.equal(
    container.querySelector('[data-testid="account-danger-zone"]'),
    null,
  );
  assert.ok(button("Delete", container));
  assert.ok(button("Sign out", container));
});
