// @vitest-environment jsdom

import { createElement } from "react";
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
import { AddCredentialDialog } from "./add-credential-dialog";

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
  ReturnType<Parameters<typeof AddCredentialDialog>[0]["onCheck"]>
>;

const okResult: CheckResult = { ready: true, reason: "", message: "" };

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "" };
}

async function mountDialog(
  overrides: Partial<Parameters<typeof AddCredentialDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(okResult);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddCredentialDialog, {
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
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function endpointField() {
  return field("webdavEndpoint");
}
function usernameField() {
  return field("webdavUsername");
}
function passwordField() {
  return field("webdavPassword");
}
function rootsField() {
  return document.querySelector<HTMLTextAreaElement>(
    'textarea[name="webdavRoots"]',
  )!;
}

async function fillCredential(
  endpoint = "https://cloud.example.com/dav",
  username = "alice",
  secret = "app-pass",
) {
  typeInto(endpointField(), endpoint);
  typeInto(usernameField(), username);
  typeInto(passwordField(), secret);
  await flush(3);
}

async function testConnection() {
  await click(button("Test connection"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("the password field is type=password with autoComplete new-password", async () => {
  await mountDialog();
  expect(passwordField().type).toBe("password");
  expect(passwordField().getAttribute("autocomplete")).toBe("new-password");
});

test("a successful check shows the verified state, prefills the name, and enables Add", async () => {
  const { onCheck } = await mountDialog();

  await fillCredential();
  expect(button("Add connection").disabled).toBe(true);
  await testConnection();

  expect(onCheck).toHaveBeenCalledWith({
    endpoint: "https://cloud.example.com/dav",
    username: "alice",
    secret: "app-pass",
  });
  expect(bodyText()).toContain("Connection verified");
  expect(field("webdavName").value).toBe("cloud.example.com");
  expect(button("Add connection").disabled).toBe(false);
});

test.each([
  ["reauth_required", "rejected the username or app password"],
  ["blocked_endpoint", "not allowed by this deployment"],
  ["unreachable", "could not be reached"],
  ["config_invalid", "server address is not valid"],
])(
  "a %s check result shows its localized text and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady(reason)) });

    await fillCredential();
    await testConnection();

    expect(bodyText()).toContain(text);
    expect(button("Add connection").disabled).toBe(true);
  },
);

test("an endpoint with user:pass@ is rejected without calling onCheck", async () => {
  const { onCheck } = await mountDialog();

  await fillCredential("https://user:pw@cloud.example.com/dav");
  await testConnection();

  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("without a username, password or query string");
});

test("a username with a colon is rejected without calling onCheck", async () => {
  const { onCheck } = await mountDialog();

  await fillCredential("https://cloud.example.com/dav", "al:ice");
  await testConnection();

  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("without a colon");
});

test("a check that throws shows a retryable message and keeps Add disabled", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("network down")),
  });

  await fillCredential();
  await testConnection();

  expect(bodyText()).toContain("Could not reach this server");
  expect(button("Add connection").disabled).toBe(true);
});

test("Add submits the endpoint, credential and default root, then closes", async () => {
  const { onAdd, onOpenChange } = await mountDialog();

  await fillCredential();
  await testConnection();
  typeInto(field("webdavName"), "My server");
  await flush(3);
  await click(button("Add connection"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    name: "My server",
    endpoint: "https://cloud.example.com/dav",
    username: "alice",
    secret: "app-pass",
    roots: ["/"],
    // Scheduled reconciliation is opt-in; the checkbox is off by default.
    periodicIndexingEnabled: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("Sync automatically is off by default", async () => {
  const { onAdd } = await mountDialog();

  await fillCredential();
  await testConnection();
  await click(button("Add connection"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ periodicIndexingEnabled: false }),
  );
});

test("checking Sync automatically sends periodicIndexingEnabled true", async () => {
  const { onAdd } = await mountDialog();

  await fillCredential();
  await testConnection();
  const checkbox = document.querySelector<HTMLButtonElement>(
    "#add-webdav-autosync",
  )!;
  await click(checkbox);
  await flush(3);
  await click(button("Add connection"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ periodicIndexingEnabled: true }),
  );
});

test("typed folder paths are normalized into roots", async () => {
  const { onAdd } = await mountDialog();

  await fillCredential();
  await testConnection();
  typeInto(rootsField(), "/Documents\n/Photos/");
  await flush(3);
  await click(button("Add connection"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ roots: ["/Documents/", "/Photos/"] }),
  );
});

test("editing the endpoint after a check disables Add again", async () => {
  await mountDialog();

  await fillCredential();
  await testConnection();
  expect(button("Add connection").disabled).toBe(false);

  typeInto(endpointField(), "https://other.example.com/dav");
  await flush(3);
  expect(button("Add connection").disabled).toBe(true);
});

test("a failed Add clears the password and disables Add", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS",
    }),
  );
  const { onOpenChange } = await mountDialog({ onAdd });

  await fillCredential();
  await testConnection();
  await click(button("Add connection"));
  await flush(5);

  expect(bodyText()).toContain("already exists in this workspace");
  // The app password is dropped from state after the failed submit.
  expect(passwordField().value).toBe("");
  expect(button("Add connection").disabled).toBe(true);
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("a check that finishes after an input changed is ignored", async () => {
  let resolveCheck: (value: CheckResult) => void = () => {};
  const onCheck = vi.fn().mockReturnValue(
    new Promise<CheckResult>((resolve) => {
      resolveCheck = resolve;
    }),
  );
  await mountDialog({ onCheck });

  await fillCredential();
  await click(button("Test connection"));
  typeInto(usernameField(), "bob");
  await flush(3);
  resolveCheck(okResult);
  await flush(5);

  expect(button("Add connection").disabled).toBe(true);
  expect(bodyText()).not.toContain("Connection verified");
});
