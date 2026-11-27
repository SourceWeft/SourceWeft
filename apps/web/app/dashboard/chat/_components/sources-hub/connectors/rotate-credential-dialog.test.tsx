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

// Zotero: the stored username is `<users|groups>/<id>`, derived from the
// connector's config, so the member only supplies the new API key.
const zoteroGroupConfig = {
  libraryType: "group",
  libraryId: "2205533",
  items: [],
};

function zoteroKeyField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="zoteroApiKey"]',
  )!;
}

test("a Zotero connector asks for the key only and sends the derived library username", async () => {
  const { onRotate, onOpenChange } = await mountDialog({
    connectorName: "Lab library",
    connectorType: "zotero",
    configJson: zoteroGroupConfig,
    initialUsername: "groups/2205533",
  });

  expect(usernameField()).toBeNull();
  expect(document.body.textContent).toContain("Reconnect Zotero");
  expect(document.body.textContent).toContain("groups/2205533");
  expect(zoteroKeyField().type).toBe("password");
  expect(button("Reconnect").disabled).toBe(true);

  typeInto(zoteroKeyField(), "NewKeyAbC9");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(onRotate).toHaveBeenCalledWith({
    username: "groups/2205533",
    secret: "NewKeyAbC9",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("a personal Zotero connector derives users/<id>", async () => {
  const { onRotate } = await mountDialog({
    connectorType: "zotero",
    configJson: { libraryType: "user", libraryId: "42", items: [] },
  });

  typeInto(zoteroKeyField(), "NewKeyAbC9");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(onRotate).toHaveBeenCalledWith({
    username: "users/42",
    secret: "NewKeyAbC9",
  });
});

test("a Zotero key with a space keeps Reconnect disabled", async () => {
  const { onRotate } = await mountDialog({
    connectorType: "zotero",
    configJson: zoteroGroupConfig,
  });

  typeInto(zoteroKeyField(), "bad key");
  await flush(3);
  expect(button("Reconnect").disabled).toBe(true);
  await click(button("Reconnect"));
  await flush(5);
  expect(onRotate).not.toHaveBeenCalled();
});

test("a Zotero connector with missing library details cannot be rotated", async () => {
  const { onRotate } = await mountDialog({
    connectorType: "zotero",
    configJson: {},
  });

  expect(document.body.textContent).toContain("library details are missing");
  typeInto(zoteroKeyField(), "NewKeyAbC9");
  await flush(3);
  expect(button("Reconnect").disabled).toBe(true);
  expect(onRotate).not.toHaveBeenCalled();
});

test("a failed Zotero rotate clears the key and never renders it", async () => {
  const onRotate = vi.fn().mockRejectedValue(new Error("boom"));
  await mountDialog({
    onRotate,
    connectorType: "zotero",
    configJson: zoteroGroupConfig,
  });

  typeInto(zoteroKeyField(), "NewKeyAbC9");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(zoteroKeyField().value).toBe("");
  expect(document.body.innerHTML).not.toContain("NewKeyAbC9");
  expect(button("Reconnect").disabled).toBe(true);
});

function wordpressUsernameField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="wordpressUsername"]',
  )!;
}
function wordpressPasswordField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="wordpressPassword"]',
  )!;
}

test("a WordPress login connector asks for a username and a new Application Password", async () => {
  const { onRotate } = await mountDialog({
    connectorType: "wordpress_login",
    connectorName: "My blog",
  });

  // WordPress copy, not WebDAV, and its own field names.
  expect(document.body.textContent).toContain("Reconnect WordPress");
  expect(document.body.textContent).toContain("Application Password");
  expect(wordpressPasswordField().type).toBe("password");
  expect(wordpressUsernameField().value).toBe("alice");

  typeInto(wordpressPasswordField(), "wxyz 7890 wxyz 7890");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(onRotate).toHaveBeenCalledWith({
    username: "alice",
    secret: "wxyz 7890 wxyz 7890",
  });
});

test("a failed WordPress rotate clears the Application Password and never renders it", async () => {
  const onRotate = vi.fn().mockRejectedValue(new Error("boom"));
  await mountDialog({ onRotate, connectorType: "wordpress_login" });

  typeInto(wordpressPasswordField(), "secret 0000 secret");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(wordpressPasswordField().value).toBe("");
  expect(document.body.innerHTML).not.toContain("secret 0000 secret");
  expect(button("Reconnect").disabled).toBe(true);
});

function ghostKeyField() {
  return document.querySelector<HTMLInputElement>('input[name="ghostApiKey"]')!;
}

test("a Ghost connector asks for the Content API key only and sends the fixed username", async () => {
  const { onRotate, onOpenChange } = await mountDialog({
    connectorName: "Company blog",
    connectorType: "ghost",
    configJson: { siteUrl: "https://demo.ghost.io", items: [] },
    initialUsername: "content-api",
  });

  expect(usernameField()).toBeNull();
  expect(document.body.textContent).toContain("Reconnect Ghost");
  expect(document.body.textContent).toContain("Company blog");
  expect(ghostKeyField().type).toBe("password");
  expect(ghostKeyField().getAttribute("autocomplete")).toBe("new-password");
  expect(button("Reconnect").disabled).toBe(true);

  typeInto(ghostKeyField(), "22444f78447824223cefc48062");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(onRotate).toHaveBeenCalledWith({
    username: "content-api",
    secret: "22444f78447824223cefc48062",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("the Ghost key input is bound to a hint that does not refer to a missing URL field", async () => {
  await mountDialog({ connectorType: "ghost" });
  const hintId = ghostKeyField().getAttribute("aria-describedby");
  expect(hintId).toBeTruthy();
  const hint = document.getElementById(hintId!)?.textContent ?? "";
  expect(hint).toContain("Ghost Admin");
  expect(hint).toContain("Integrations");
  expect(hint).not.toMatch(/\bsame\b/i);
});

test("a Ghost key with a space keeps Reconnect disabled", async () => {
  const { onRotate } = await mountDialog({ connectorType: "ghost" });

  typeInto(ghostKeyField(), "bad key");
  await flush(3);
  expect(button("Reconnect").disabled).toBe(true);
  await click(button("Reconnect"));
  await flush(5);
  expect(onRotate).not.toHaveBeenCalled();
});

test("a failed Ghost rotate clears the key and never renders it", async () => {
  // An error with no message shows the Ghost fallback copy.
  const onRotate = vi.fn().mockRejectedValue(new Error(""));
  await mountDialog({ onRotate, connectorType: "ghost" });

  typeInto(ghostKeyField(), "SecretKey777");
  await flush(3);
  await click(button("Reconnect"));
  await flush(5);

  expect(ghostKeyField().value).toBe("");
  expect(document.body.innerHTML).not.toContain("SecretKey777");
  expect(document.body.textContent).toContain(
    "Could not update the Content API key",
  );
  expect(button("Reconnect").disabled).toBe(true);
});
