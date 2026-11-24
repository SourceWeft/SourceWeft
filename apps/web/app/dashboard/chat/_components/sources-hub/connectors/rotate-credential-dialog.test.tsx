// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";
import { RotateCredentialDialog } from "./rotate-credential-dialog";

afterEach(unmountAll);

async function mountDialog(
  overrides: Partial<Parameters<typeof RotateCredentialDialog>[0]> = {},
) {
  const onRotate = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(RotateCredentialDialog, {
      open: true,
      connectorName: "My WebDAV",
      initialUsername: "alice",
      onOpenChange,
      onRotate,
      ...overrides,
    }),
  );
  return { onRotate, onOpenChange };
}

function usernameField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="webdavUsername"]',
  )!;
}
function passwordField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="webdavPassword"]',
  )!;
}

test("prefills the current username and uses a password input", async () => {
  await mountDialog();
  expect(usernameField().value).toBe("alice");
  expect(passwordField().type).toBe("password");
  expect(passwordField().getAttribute("autocomplete")).toBe("new-password");
});

test("Reconnect is disabled until a password is entered", async () => {
  await mountDialog();
  expect(button("Reconnect").disabled).toBe(true);

  typeInto(passwordField(), "new-pass");
  await flush(3);
  expect(button("Reconnect").disabled).toBe(false);
});

test("Reconnect calls onRotate with the username and secret, then closes", async () => {
  const { onRotate, onOpenChange } = await mountDialog();

  typeInto(passwordField(), "new-pass");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(onRotate).toHaveBeenCalledWith({
    username: "alice",
    secret: "new-pass",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("a username with a colon keeps Reconnect disabled and never calls onRotate", async () => {
  const { onRotate } = await mountDialog({ initialUsername: "al:ice" });

  typeInto(passwordField(), "new-pass");
  await flush(3);

  expect(button("Reconnect").disabled).toBe(true);
  await click(button("Reconnect"));
  await flush(5);
  expect(onRotate).not.toHaveBeenCalled();
});

test("a failed rotate clears the password and stays open", async () => {
  const onRotate = vi.fn().mockRejectedValue(new Error("boom"));
  const { onOpenChange } = await mountDialog({ onRotate });

  typeInto(passwordField(), "new-pass");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(passwordField().value).toBe("");
  expect(button("Reconnect").disabled).toBe(true);
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});
