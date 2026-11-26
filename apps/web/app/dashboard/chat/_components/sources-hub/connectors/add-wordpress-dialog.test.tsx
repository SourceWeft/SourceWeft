// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { HttpClientError } from "@sourceweft/sdk";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";
import { AddWordpressDialog } from "./add-wordpress-dialog";

// The Radix Checkbox renders a hidden form input that measures itself with a
// ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

afterEach(unmountAll);

type CheckResult = Awaited<
  ReturnType<Parameters<typeof AddWordpressDialog>[0]["onCheck"]>
>;

const ready: CheckResult = { ready: true, reason: "", message: "" };

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "" };
}

const SITE = "https://blog.example.com";
const SECRET = "abcd 1234 efgh 5678";

async function mountDialog(
  overrides: Partial<Parameters<typeof AddWordpressDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(ready);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddWordpressDialog, {
      open: true,
      onOpenChange,
      onCheck,
      onAdd,
      ...overrides,
    }),
  );
  return { onCheck, onAdd, onOpenChange };
}

function field(name: string) {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
}
const urlField = () => field("wordpressSiteUrl")!;
const usernameField = () => field("wordpressUsername")!;
const passwordField = () => field("wordpressPassword")!;
const nameField = () => field("wordpressName")!;

function accessRadio(value: "public" | "login") {
  return document.querySelector<HTMLButtonElement>(
    `button[role="radio"][value="${value}"]`,
  )!;
}

async function chooseLogin() {
  await click(accessRadio("login"));
  await flush(3);
}

async function check() {
  await click(button("Check site"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("explains the access choices, the Application Password and WordPress.com", async () => {
  await mountDialog();
  const text = bodyText();
  expect(text).toContain("Public site");
  expect(text).toContain("Sign in with an Application Password");
  expect(text).toContain("WordPress.com hosted sites are supported");
  // Public is the default.
  expect(accessRadio("public").getAttribute("aria-checked")).toBe("true");
  expect(accessRadio("login").getAttribute("aria-checked")).toBe("false");
});

test("the drafts checkbox and credential fields appear only for the login choice", async () => {
  await mountDialog();
  // Public choice: no credential fields, no drafts checkbox.
  expect(field("wordpressUsername")).toBeNull();
  expect(field("wordpressPassword")).toBeNull();
  expect(document.querySelector("#add-wordpress-unpublished")).toBeNull();

  await chooseLogin();
  expect(field("wordpressUsername")).not.toBeNull();
  expect(field("wordpressPassword")).not.toBeNull();
  const checkbox = document.querySelector("#add-wordpress-unpublished");
  expect(checkbox).not.toBeNull();
  expect(bodyText()).toContain(
    "Every workspace member will see drafts and private posts",
  );
  // The Application Password is a secret.
  expect(passwordField().type).toBe("password");
  expect(passwordField().getAttribute("autocomplete")).toBe("new-password");
});

test("the public path checks and creates the wordpress connector with an empty selection", async () => {
  const { onCheck, onAdd, onOpenChange } = await mountDialog();
  typeInto(urlField(), `  ${SITE}  `);
  await flush(3);
  expect(button("Add site").disabled).toBe(true);
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    access: "public",
    siteUrl: SITE,
    includeUnpublished: false,
  });
  expect(bodyText()).toContain("Site reachable");
  expect(button("Add site").disabled).toBe(false);

  await click(button("Add site"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    access: "public",
    siteUrl: SITE,
    includeUnpublished: false,
    name: "WordPress",
    periodicIndexingEnabled: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("the login path checks and creates wordpress_login with the credential and drafts flag", async () => {
  const { onCheck, onAdd } = await mountDialog();
  typeInto(urlField(), SITE);
  await chooseLogin();
  typeInto(usernameField(), "alice");
  typeInto(passwordField(), SECRET);
  await flush(3);
  await click(
    document.querySelector<HTMLButtonElement>("#add-wordpress-unpublished")!,
  );
  await flush(3);
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    access: "login",
    siteUrl: SITE,
    includeUnpublished: true,
    credential: { username: "alice", secret: SECRET },
  });
  expect(button("Add site").disabled).toBe(false);

  await click(button("Add site"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    access: "login",
    siteUrl: SITE,
    includeUnpublished: true,
    credential: { username: "alice", secret: SECRET },
    name: "WordPress",
    periodicIndexingEnabled: false,
  });
});

test("the login check needs a username and password before it runs", async () => {
  const { onCheck } = await mountDialog();
  typeInto(urlField(), SITE);
  await chooseLogin();
  await flush(3);
  // No credential yet: Check stays disabled.
  expect(button("Check site").disabled).toBe(true);

  typeInto(usernameField(), "al:ice");
  typeInto(passwordField(), SECRET);
  await flush(3);
  await check();
  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("without a colon");
});

test.each([
  ["http", "http://blog.example.com"],
  ["a username and password", "https://user:pw@blog.example.com"],
  ["a query", "https://blog.example.com/?a=1"],
  ["an IP address", "https://192.168.1.1"],
  ["localhost", "https://localhost"],
])(
  "a public address with %s is rejected without calling onCheck",
  async (_l, url) => {
    const { onCheck } = await mountDialog();
    typeInto(urlField(), url);
    await flush(3);
    await check();
    expect(onCheck).not.toHaveBeenCalled();
    expect(bodyText()).toContain("starting with https://");
    expect(button("Add site").disabled).toBe(true);
  },
);

test.each([
  ["login_required", "needs a login"],
  ["not_a_wordpress_site", "not a WordPress site"],
  ["rest_disabled", "REST API is turned off"],
  ["reauth_required", "rejected the username or Application Password"],
  ["insufficient_permission", "cannot read drafts and private posts"],
  ["blocked_endpoint", "redirects to a different address"],
  ["rate_limited", "limiting requests"],
  ["unreachable", "could not be reached"],
  ["config_invalid", "site address is not valid"],
])(
  "a %s check result shows its own copy and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady(reason)) });
    typeInto(urlField(), SITE);
    await flush(3);
    await check();
    expect(bodyText()).toContain(text);
    expect(bodyText()).not.toContain("Site reachable");
    expect(button("Add site").disabled).toBe(true);
  },
);

test("an unknown reason falls back to the generic not-ready copy", async () => {
  await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady("new")) });
  typeInto(urlField(), SITE);
  await flush(3);
  await check();
  expect(bodyText()).toContain("Connector is not ready to sync.");
  expect(button("Add site").disabled).toBe(true);
});

test("editing the access choice after a check invalidates it", async () => {
  await mountDialog();
  typeInto(urlField(), SITE);
  await flush(3);
  await check();
  expect(button("Add site").disabled).toBe(false);

  await chooseLogin();
  expect(button("Add site").disabled).toBe(true);
  expect(bodyText()).not.toContain("Site reachable");
});

test("the Application Password is cleared after submit and never rendered in a URL", async () => {
  const { onAdd } = await mountDialog();
  typeInto(urlField(), SITE);
  await chooseLogin();
  typeInto(usernameField(), "alice");
  typeInto(passwordField(), SECRET);
  await flush(3);
  await check();
  await click(button("Add site"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledTimes(1);
  // The secret is dropped from state after the submit (the field is empty if it
  // is still mounted), and it is never placed in any anchor href.
  const password = field("wordpressPassword");
  if (password) expect(password.value).toBe("");
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    expect(anchor.getAttribute("href")).not.toContain(SECRET);
  }
});

test("a failed login create clears the password and keeps the dialog open", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS",
    }),
  );
  const { onOpenChange } = await mountDialog({ onAdd });
  typeInto(urlField(), SITE);
  await chooseLogin();
  typeInto(usernameField(), "alice");
  typeInto(passwordField(), SECRET);
  await flush(3);
  await check();
  await click(button("Add site"));
  await flush(5);

  expect(bodyText()).toContain("already exists in this workspace");
  expect(passwordField().value).toBe("");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("a duplicate name shows the name-conflict copy", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  await mountDialog({ onAdd });
  typeInto(urlField(), SITE);
  await flush(3);
  await check();
  await click(button("Add site"));
  await flush(5);
  expect(bodyText()).toContain("connector with this name already exists");
});

test("two rapid Add clicks send one create request", async () => {
  let resolveAdd: () => void = () => {};
  const onAdd = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      resolveAdd = resolve;
    }),
  );
  await mountDialog({ onAdd });
  typeInto(urlField(), SITE);
  await flush(3);
  await check();

  const add = button("Add site");
  await act(async () => {
    add.click();
    add.click();
  });
  expect(onAdd).toHaveBeenCalledTimes(1);

  resolveAdd();
  await flush(5);
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("Sync automatically is off by default and can be turned on", async () => {
  const { onAdd } = await mountDialog();
  typeInto(urlField(), SITE);
  await flush(3);
  await check();
  const checkbox = document.querySelector<HTMLButtonElement>(
    "#add-wordpress-autosync",
  )!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await click(checkbox);
  await flush(3);
  await click(button("Add site"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ periodicIndexingEnabled: true }),
  );
});

test("an empty name falls back to WordPress", async () => {
  const { onAdd } = await mountDialog();
  typeInto(urlField(), SITE);
  await flush(3);
  await check();
  typeInto(nameField(), "   ");
  await flush(3);
  await click(button("Add site"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ name: "WordPress" }),
  );
});
