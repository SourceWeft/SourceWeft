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
import { AddGhostDialog } from "./add-ghost-dialog";

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
  ReturnType<Parameters<typeof AddGhostDialog>[0]["onCheck"]>
>;

const ready: CheckResult = { ready: true, reason: "", message: "" };

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "" };
}

const SITE = "https://demo.ghost.io";
const KEY = "22444f78447824223cefc48062";

async function mountDialog(
  overrides: Partial<Parameters<typeof AddGhostDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(ready);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddGhostDialog, {
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
const urlField = () => field("ghostSiteUrl");
const keyField = () => field("ghostApiKey");
const nameField = () => field("ghostName");

async function fill(url = SITE, key = KEY) {
  typeInto(urlField(), url);
  typeInto(keyField(), key);
  await flush(3);
}

async function check() {
  await click(button("Check connection"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("the Content API key field is a password input that autocompletes nothing", async () => {
  await mountDialog();
  expect(keyField().type).toBe("password");
  expect(keyField().getAttribute("autocomplete")).toBe("new-password");
  expect(keyField().maxLength).toBe(256);
  // The API URL is not a secret.
  expect(urlField().type).toBe("url");
});

test("says where the API URL and Content API key are found and what is read", async () => {
  await mountDialog();
  const text = bodyText();
  expect(text).toContain("Ghost Admin");
  expect(text).toContain("Settings");
  expect(text).toContain("Integrations");
  expect(text).toMatch(/custom integration/i);
  expect(text).toMatch(/only published/i);
  expect(text).toMatch(/members-only and paid/i);
  expect(text).toMatch(/drafts are not supported/i);
  // No Admin API wording: the connector never asks for an Admin API key.
  expect(text).not.toMatch(/admin api/i);
});

test("Check is disabled until the API URL and key are entered", async () => {
  await mountDialog();
  expect(button("Check connection").disabled).toBe(true);
  typeInto(urlField(), SITE);
  await flush(3);
  expect(button("Check connection").disabled).toBe(true);
  typeInto(keyField(), KEY);
  await flush(3);
  expect(button("Check connection").disabled).toBe(false);
});

test.each([
  ["http", "http://demo.ghost.io"],
  ["a port", "https://demo.ghost.io:2368"],
  ["userinfo", "https://user:pw@demo.ghost.io"],
  ["an IP literal", "https://127.0.0.1"],
  ["a query", "https://demo.ghost.io/?key=abc"],
])(
  "an API URL with %s is rejected without calling onCheck",
  async (_l, url) => {
    const { onCheck } = await mountDialog();
    await fill(url);
    await check();
    expect(onCheck).not.toHaveBeenCalled();
    expect(bodyText()).toContain("starting with https://");
    expect(urlField().getAttribute("aria-invalid")).toBe("true");
  },
);

test("a key with a space is rejected without calling onCheck", async () => {
  const { onCheck } = await mountDialog();
  await fill(SITE, "abc def");
  await check();
  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("Content API key without spaces");
  expect(keyField().getAttribute("aria-invalid")).toBe("true");
});

test("check then add sends the trimmed URL and the key, and creates the connector", async () => {
  const { onCheck, onAdd, onOpenChange } = await mountDialog();
  typeInto(urlField(), `  ${SITE}/  `);
  typeInto(keyField(), KEY);
  await flush(3);
  expect(button("Add site").disabled).toBe(true);
  await check();

  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onCheck).toHaveBeenCalledWith({ siteUrl: `${SITE}/`, secret: KEY });
  expect(bodyText()).toContain("Site verified");
  expect(nameField().value).toBe("Ghost");
  expect(button("Add site").disabled).toBe(false);
  // The scan skips members-only and paid posts, and the selection comes later.
  expect(bodyText()).toMatch(/members-only and paid/i);

  typeInto(nameField(), "Company blog");
  await flush(3);
  await click(button("Add site"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith({
    siteUrl: `${SITE}/`,
    secret: KEY,
    name: "Company blog",
    // Scheduled reconciliation is opt-in.
    periodicIndexingEnabled: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("an empty name falls back to Ghost", async () => {
  const { onAdd } = await mountDialog();
  await fill();
  await check();
  typeInto(nameField(), "   ");
  await flush(3);
  await click(button("Add site"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Ghost" }),
  );
});

test("Sync automatically is off by default and can be turned on", async () => {
  const { onAdd } = await mountDialog();
  await fill();
  await check();
  const checkbox = document.querySelector<HTMLButtonElement>(
    "#add-ghost-autosync",
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

test.each([
  ["url", async () => typeInto(urlField(), "https://other.example.com")],
  ["key", async () => typeInto(keyField(), "0123456789abcdef")],
])("editing the %s after a check invalidates it", async (_field, edit) => {
  await mountDialog();
  await fill();
  await check();
  expect(button("Add site").disabled).toBe(false);

  await edit();
  await flush(3);
  expect(button("Add site").disabled).toBe(true);
  expect(bodyText()).not.toContain("Site verified");
});

test.each([
  ["reauth_required", "Ghost rejected this Content API key"],
  ["not_a_ghost_site", "not a Ghost site"],
  ["blocked_endpoint", "address the site itself uses"],
  ["config_invalid", "API URL is not valid"],
  ["unreachable", "could not be reached"],
  ["rate_limited", "limiting requests"],
])(
  "a %s check result shows its own copy and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady(reason)) });
    await fill();
    await check();
    expect(bodyText()).toContain(text);
    expect(button("Add site").disabled).toBe(true);
  },
);

test("an unknown reason falls back to the generic not-ready copy", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue(notReady("something_new")),
  });
  await fill();
  await check();
  expect(button("Add site").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});

test("a check that throws shows a retryable message and keeps Add disabled", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("network down")),
  });
  await fill();
  await check();
  expect(bodyText()).toContain("Could not check the site");
  expect(button("Add site").disabled).toBe(true);
});

test("a successful Add clears the key from the form before it closes", async () => {
  const { onOpenChange } = await mountDialog();
  await fill(SITE, "SecretKey777");
  await check();
  await click(button("Add site"));
  await flush(5);

  expect(onOpenChange).toHaveBeenCalledWith(false);
  // The test keeps the dialog mounted, so the cleared state is observable.
  expect(keyField().value).toBe("");
  expect(document.body.innerHTML).not.toContain("SecretKey777");
  expect(button("Add site").disabled).toBe(true);
});

test.each([
  ["CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS", "already exists in this workspace"],
  ["CONNECTOR_ALREADY_EXISTS", "name already exists"],
  ["CONNECTOR_CREDENTIAL_NOT_ALLOWED", "not allowed by this deployment"],
])(
  "a failed Add with %s clears the key, hides it and shows the Ghost copy",
  async (code, text) => {
    const onAdd = vi.fn().mockRejectedValue(
      new HttpClientError({
        message: "conflict",
        status: 409,
        statusText: "Conflict",
        code,
      }),
    );
    const { onOpenChange } = await mountDialog({ onAdd });
    await fill(SITE, "SecretKey777");
    await check();
    await click(button("Add site"));
    await flush(5);

    expect(bodyText()).toContain(text);
    // The duplicate-site message is about the site, not a library or a username.
    expect(bodyText()).not.toMatch(/library|username/i);
    expect(keyField().value).toBe("");
    expect(document.body.innerHTML).not.toContain("SecretKey777");
    expect(button("Add site").disabled).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  },
);

test("a failed check never renders the key", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("SecretKey777 leaked")),
  });
  await fill(SITE, "SecretKey777");
  await check();
  expect(bodyText()).not.toContain("SecretKey777");
});

test("the key never appears in any rendered URL or attribute", async () => {
  await mountDialog();
  await fill(SITE, "SecretKey777");
  await check();
  const urlAttributes = Array.from(
    document.querySelectorAll("[href], [src], [action]"),
  ).map(
    (node) =>
      `${node.getAttribute("href")} ${node.getAttribute("src")} ${node.getAttribute("action")}`,
  );
  expect(urlAttributes.join(" ")).not.toContain("SecretKey777");
  expect(urlField().value).not.toContain("SecretKey777");
  expect(bodyText()).not.toContain("SecretKey777");
});

test("a check that finishes after an input changed is ignored", async () => {
  let resolveCheck: (value: CheckResult) => void = () => {};
  const onCheck = vi.fn().mockReturnValue(
    new Promise<CheckResult>((resolve) => {
      resolveCheck = resolve;
    }),
  );
  await mountDialog({ onCheck });
  await fill();
  await click(button("Check connection"));
  typeInto(urlField(), "https://other.example.com");
  await flush(3);
  resolveCheck(ready);
  await flush(5);

  expect(button("Add site").disabled).toBe(true);
  expect(bodyText()).not.toContain("Site verified");
});

test("two rapid Add clicks send one create request", async () => {
  let resolveAdd: () => void = () => {};
  const onAdd = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      resolveAdd = resolve;
    }),
  );
  await mountDialog({ onAdd });
  await fill();
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

test("the URL and key inputs point at their hints", async () => {
  await mountDialog();
  for (const input of [urlField(), keyField()]) {
    const hintId = input.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)?.textContent?.trim()).toBeTruthy();
    // Empty is not yet invalid.
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  }
});
