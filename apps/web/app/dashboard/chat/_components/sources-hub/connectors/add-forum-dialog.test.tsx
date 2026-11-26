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
import { AddForumDialog } from "./add-forum-dialog";

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
  ReturnType<Parameters<typeof AddForumDialog>[0]["onCheck"]>
>;

// A reachable forum with nothing chosen yet: the adapter reports
// `selection_required`, which the dialog treats as success.
const reachable: CheckResult = {
  ready: false,
  reason: "selection_required",
  message: "",
};

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "" };
}

const FORUM = "https://forum.example.com";

async function mountDialog(
  overrides: Partial<Parameters<typeof AddForumDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(reachable);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddForumDialog, {
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
const urlField = () => field("forumUrl");
const nameField = () => field("forumName");

function radio(value: "light" | "deep") {
  return document.querySelector<HTMLButtonElement>(
    `button[role="radio"][value="${value}"]`,
  )!;
}

async function enterUrl(value = FORUM) {
  typeInto(urlField(), value);
  await flush(3);
}

async function check() {
  await click(button("Check forum"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("explains the address, the refresh modes and that private forums are not supported", async () => {
  await mountDialog();
  const text = bodyText();
  expect(text).toContain("address of the forum's home page");
  expect(text).toContain(
    "Private forums that require a login are not supported",
  );
  // Both modes say what they pick up; light is the default.
  expect(text).toContain("new replies");
  expect(text).toContain("edits to older posts");
  expect(radio("light").getAttribute("aria-checked")).toBe("true");
  expect(radio("deep").getAttribute("aria-checked")).toBe("false");
});

test("Check is disabled until an address is entered", async () => {
  await mountDialog();
  expect(button("Check forum").disabled).toBe(true);
  await enterUrl();
  expect(button("Check forum").disabled).toBe(false);
});

test.each([
  ["http", "http://forum.example.com"],
  ["a username and password", "https://user:pw@forum.example.com"],
  ["a query", "https://forum.example.com/?a=1"],
  ["a fragment", "https://forum.example.com/#top"],
  ["an IP address", "https://192.168.1.1"],
  ["localhost", "https://localhost"],
  ["no scheme", "forum.example.com"],
])(
  "an address with %s is rejected without calling onCheck",
  async (_l, url) => {
    const { onCheck } = await mountDialog();
    await enterUrl(url);
    await check();

    expect(onCheck).not.toHaveBeenCalled();
    expect(bodyText()).toContain("starting with https://");
    expect(button("Add forum").disabled).toBe(true);
  },
);

test("a whitespace-only address cannot be checked", async () => {
  const { onCheck } = await mountDialog();
  await enterUrl("   ");
  expect(button("Check forum").disabled).toBe(true);
  expect(onCheck).not.toHaveBeenCalled();
});

test("a reachable forum (selection_required) enables Add and says to choose next", async () => {
  const { onCheck } = await mountDialog();
  await enterUrl();
  expect(button("Add forum").disabled).toBe(true);
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    connectorType: "discourse",
    configJson: { forumUrl: FORUM, items: [], refresh: "light" },
  });
  expect(bodyText()).toContain("Forum reachable");
  expect(bodyText()).toContain("choose the categories or topics");
  expect(button("Add forum").disabled).toBe(false);
});

test("a ready result is accepted too", async () => {
  await mountDialog({
    onCheck: vi
      .fn()
      .mockResolvedValue({ ready: true, reason: "", message: "" }),
  });
  await enterUrl();
  await check();
  expect(button("Add forum").disabled).toBe(false);
});

test("check then add sends the exact config, trims the address and closes the dialog", async () => {
  const { onCheck, onAdd, onOpenChange } = await mountDialog();
  await enterUrl(`  ${FORUM}/community  `);
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    connectorType: "discourse",
    configJson: {
      forumUrl: `${FORUM}/community`,
      items: [],
      refresh: "light",
    },
  });
  expect(nameField().value).toBe("Discourse");

  typeInto(nameField(), "Community");
  await flush(3);
  await click(button("Add forum"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    connectorType: "discourse",
    name: "Community",
    configJson: {
      forumUrl: `${FORUM}/community`,
      items: [],
      refresh: "light",
    },
    // Scheduled reconciliation is opt-in.
    periodicIndexingEnabled: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("deep refresh is sent in both the check and the create", async () => {
  const { onCheck, onAdd } = await mountDialog();
  await enterUrl();
  await click(radio("deep"));
  await flush(3);
  await check();
  await click(button("Add forum"));
  await flush(5);

  const config = { forumUrl: FORUM, items: [], refresh: "deep" };
  expect(onCheck).toHaveBeenCalledWith({
    connectorType: "discourse",
    configJson: config,
  });
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ configJson: config }),
  );
});

test("an empty name falls back to Discourse", async () => {
  const { onAdd } = await mountDialog();
  await enterUrl();
  await check();
  typeInto(nameField(), "   ");
  await flush(3);
  await click(button("Add forum"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Discourse" }),
  );
});

test("Sync automatically is off by default and can be turned on", async () => {
  const { onAdd } = await mountDialog();
  await enterUrl();
  await check();
  const checkbox = document.querySelector<HTMLButtonElement>(
    "#add-forum-autosync",
  )!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await click(checkbox);
  await flush(3);
  await click(button("Add forum"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ periodicIndexingEnabled: true }),
  );
});

test.each([
  [
    "the address",
    async () => typeInto(urlField(), "https://other.example.com"),
  ],
  ["the refresh mode", async () => click(radio("deep"))],
])("editing %s after a check invalidates it", async (_field, edit) => {
  await mountDialog();
  await enterUrl();
  await check();
  expect(button("Add forum").disabled).toBe(false);

  await edit();
  await flush(3);
  expect(button("Add forum").disabled).toBe(true);
  expect(bodyText()).not.toContain("Forum reachable");
});

test.each([
  ["login_required", "requires a login"],
  ["not_a_discourse_site", "not a Discourse forum"],
  ["forum_unreachable", "could not be reached"],
  ["blocked_endpoint", "does not allow connections to this address"],
  ["rate_limited", "limiting requests"],
  ["config_invalid", "address or refresh mode is not valid"],
])(
  "a %s check result shows its own copy and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady(reason)) });
    await enterUrl();
    await check();
    expect(bodyText()).toContain(text);
    expect(bodyText()).not.toContain("Forum reachable");
    expect(button("Add forum").disabled).toBe(true);
  },
);

test("an unknown reason falls back to the generic not-ready copy", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue(notReady("something_new")),
  });
  await enterUrl();
  await check();
  expect(bodyText()).toContain("Connector is not ready to sync.");
  expect(button("Add forum").disabled).toBe(true);
});

test("a thrown check shows the check-failed copy and keeps Add disabled", async () => {
  await mountDialog({ onCheck: vi.fn().mockRejectedValue(new Error("boom")) });
  await enterUrl();
  await check();
  expect(bodyText()).toContain("Could not check the forum");
  expect(button("Add forum").disabled).toBe(true);
});

test("a check that resolves after the address was edited is discarded", async () => {
  let resolveCheck: (value: CheckResult) => void = () => {};
  const onCheck = vi.fn().mockReturnValue(
    new Promise<CheckResult>((resolve) => {
      resolveCheck = resolve;
    }),
  );
  await mountDialog({ onCheck });
  await enterUrl();
  await click(button("Check forum"));
  typeInto(urlField(), "https://other.example.com");
  await flush(3);
  resolveCheck(reachable);
  await flush(5);

  expect(button("Add forum").disabled).toBe(true);
  expect(bodyText()).not.toContain("Forum reachable");
});

test("two rapid Add clicks send one create request", async () => {
  let resolveAdd: () => void = () => {};
  const onAdd = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      resolveAdd = resolve;
    }),
  );
  await mountDialog({ onAdd });
  await enterUrl();
  await check();

  const add = button("Add forum");
  await act(async () => {
    add.click();
    add.click();
  });
  expect(onAdd).toHaveBeenCalledTimes(1);

  resolveAdd();
  await flush(5);
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("a duplicate name shows the name-conflict copy and keeps the dialog open", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  const { onOpenChange } = await mountDialog({ onAdd });
  await enterUrl();
  await check();
  await click(button("Add forum"));
  await flush(5);

  expect(bodyText()).toContain("connector with this name already exists");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("any other create failure shows the add-failed copy", async () => {
  await mountDialog({ onAdd: vi.fn().mockRejectedValue("nope") });
  await enterUrl();
  await check();
  await click(button("Add forum"));
  await flush(5);
  expect(bodyText()).toContain("Failed to add the forum");
});

test("the address input points at its hint and flags an invalid value", async () => {
  await mountDialog();
  const hintId = urlField().getAttribute("aria-describedby");
  expect(hintId).toBeTruthy();
  expect(document.getElementById(hintId!)?.textContent?.trim()).toBeTruthy();
  // Empty is not yet invalid.
  expect(urlField().getAttribute("aria-invalid")).not.toBe("true");

  await enterUrl("http://forum.example.com");
  expect(urlField().getAttribute("aria-invalid")).toBe("true");

  await enterUrl(FORUM);
  expect(urlField().getAttribute("aria-invalid")).not.toBe("true");
});
