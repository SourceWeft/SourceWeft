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
import { AddApiKeyDialog } from "./add-api-key-dialog";

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
  ReturnType<Parameters<typeof AddApiKeyDialog>[0]["onCheck"]>
>;

const okResult: CheckResult = {
  ready: true,
  reason: "",
  message: "",
  metadata: { notesAccess: true },
};

function notReady(reason: string): CheckResult {
  return { ready: false, reason, message: "" };
}

async function mountDialog(
  overrides: Partial<Parameters<typeof AddApiKeyDialog>[0]> = {},
) {
  const onCheck = vi.fn().mockResolvedValue(okResult);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddApiKeyDialog, {
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
const libraryIdField = () => field("zoteroLibraryId");
const apiKeyField = () => field("zoteroApiKey");
const nameField = () => field("zoteroName");

function radio(value: "user" | "group") {
  return document.querySelector<HTMLButtonElement>(
    `button[role="radio"][value="${value}"]`,
  )!;
}

async function fill(libraryId = "123456", key = "AbCdEf123") {
  typeInto(libraryIdField(), libraryId);
  typeInto(apiKeyField(), key);
  await flush(3);
}

async function check() {
  await click(button("Check key"));
  await flush(5);
}

function bodyText() {
  return document.body.textContent ?? "";
}

test("the API key field is a password input that autocompletes nothing", async () => {
  await mountDialog();
  expect(apiKeyField().type).toBe("password");
  expect(apiKeyField().getAttribute("autocomplete")).toBe("new-password");
  expect(apiKeyField().maxLength).toBe(2000);
});

test("tells the member how to create the key and where to find the library ID", async () => {
  await mountDialog();
  const text = bodyText();
  expect(text).toContain("zotero.org/settings/keys");
  expect(text).toContain("read-only");
  expect(text).toContain("notes access");
  // Personal library is the default: its hint names the userID.
  expect(text).toContain("userID");

  await click(radio("group"));
  await flush(3);
  expect(bodyText()).toContain("zotero.org/groups/2205533");
});

test("Check is disabled until the library ID and key are entered", async () => {
  await mountDialog();
  expect(button("Check key").disabled).toBe(true);
  typeInto(libraryIdField(), "123456");
  await flush(3);
  expect(button("Check key").disabled).toBe(true);
  typeInto(apiKeyField(), "AbCdEf123");
  await flush(3);
  expect(button("Check key").disabled).toBe(false);
});

test.each([
  ["a non-digit ID", "12ab", "AbCdEf123"],
  ["an ID with a leading zero", "0123", "AbCdEf123"],
  ["an ID longer than 12 digits", "1234567890123", "AbCdEf123"],
])("%s is rejected without calling onCheck", async (_label, id, key) => {
  const { onCheck } = await mountDialog();
  await fill(id, key);
  await check();
  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("digits only");
});

test("a key with a space is rejected without calling onCheck", async () => {
  const { onCheck } = await mountDialog();
  await fill("123456", "AbC dEf");
  await check();
  expect(onCheck).not.toHaveBeenCalled();
  expect(bodyText()).toContain("API key without spaces");
});

test("a mixed-case key is accepted and sent verbatim", async () => {
  const { onCheck } = await mountDialog();
  await fill("123456", "zQ9aB7");
  await check();
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onCheck.mock.calls[0]![0].credential.secret).toBe("zQ9aB7");
});

test("a personal check sends users/<id> and the library config", async () => {
  const { onCheck } = await mountDialog();
  await fill("123456", "AbCdEf123");
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    connectorType: "zotero",
    configJson: { libraryType: "user", libraryId: "123456", items: [] },
    credential: { username: "users/123456", secret: "AbCdEf123" },
  });
  expect(bodyText()).toContain("Library verified");
});

test("check then add sends the exact config and credential for a group library", async () => {
  const { onCheck, onAdd, onOpenChange } = await mountDialog();
  await click(radio("group"));
  await flush(3);
  await fill("2205533", "GroupKey42");
  expect(button("Add library").disabled).toBe(true);
  await check();

  expect(onCheck).toHaveBeenCalledWith({
    connectorType: "zotero",
    configJson: { libraryType: "group", libraryId: "2205533", items: [] },
    credential: { username: "groups/2205533", secret: "GroupKey42" },
  });
  expect(nameField().value).toBe("Zotero");
  expect(button("Add library").disabled).toBe(false);

  typeInto(nameField(), "Lab library");
  await flush(3);
  await click(button("Add library"));
  await flush(5);

  expect(onAdd).toHaveBeenCalledWith({
    connectorType: "zotero",
    name: "Lab library",
    configJson: { libraryType: "group", libraryId: "2205533", items: [] },
    credential: { username: "groups/2205533", secret: "GroupKey42" },
    // Scheduled reconciliation is opt-in.
    periodicIndexingEnabled: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("an empty name falls back to Zotero", async () => {
  const { onAdd } = await mountDialog();
  await fill();
  await check();
  typeInto(nameField(), "   ");
  await flush(3);
  await click(button("Add library"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Zotero" }),
  );
});

test("Sync automatically is off by default and can be turned on", async () => {
  const { onAdd } = await mountDialog();
  await fill();
  await check();
  const checkbox = document.querySelector<HTMLButtonElement>(
    "#add-zotero-autosync",
  )!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await click(checkbox);
  await flush(3);
  await click(button("Add library"));
  await flush(5);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({ periodicIndexingEnabled: true }),
  );
});

test.each([
  ["libraryType", async () => click(radio("group"))],
  ["libraryId", async () => typeInto(libraryIdField(), "654321")],
  ["apiKey", async () => typeInto(apiKeyField(), "OtherKey9")],
])("editing %s after a check invalidates it", async (_field, edit) => {
  await mountDialog();
  await fill();
  await check();
  expect(button("Add library").disabled).toBe(false);

  await edit();
  await flush(3);
  expect(button("Add library").disabled).toBe(true);
  expect(bodyText()).not.toContain("Library verified");
});

test.each([
  ["reauth_required", "rejected this API key"],
  ["library_not_accessible", "cannot read this library"],
  ["library_not_found", "could not find this library"],
  ["rate_limited", "limiting requests"],
  ["unreachable", "could not be reached"],
  ["blocked_endpoint", "does not allow connections to Zotero"],
  ["config_invalid", "library type or ID is not valid"],
])(
  "a %s check result shows its own copy and keeps Add disabled",
  async (reason, text) => {
    await mountDialog({ onCheck: vi.fn().mockResolvedValue(notReady(reason)) });
    await fill();
    await check();
    expect(bodyText()).toContain(text);
    expect(button("Add library").disabled).toBe(true);
  },
);

test("an unknown reason falls back to the generic not-ready copy", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue(notReady("something_new")),
  });
  await fill();
  await check();
  expect(button("Add library").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});

test("a ready check without notes access shows the notes warning and still allows Add", async () => {
  await mountDialog({
    onCheck: vi.fn().mockResolvedValue({
      ready: true,
      reason: "",
      message: "Key cannot read notes",
      metadata: { notesAccess: false },
    }),
  });
  await fill();
  await check();
  expect(bodyText()).toContain("cannot read notes");
  expect(bodyText()).toContain("notes and annotations will not be indexed");
  expect(button("Add library").disabled).toBe(false);
});

test("a ready check with notes access shows no warning", async () => {
  await mountDialog();
  await fill();
  await check();
  expect(bodyText()).not.toContain("will not be indexed");
});

test("a check that throws shows a retryable message and keeps Add disabled", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("network down")),
  });
  await fill();
  await check();
  expect(bodyText()).toContain("Could not reach Zotero");
  expect(button("Add library").disabled).toBe(true);
});

test("a failed Add clears the key, hides it from the output and disables Add", async () => {
  const onAdd = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS",
    }),
  );
  const { onOpenChange } = await mountDialog({ onAdd });
  await fill("123456", "SecretKey777");
  await check();
  await click(button("Add library"));
  await flush(5);

  expect(bodyText()).toContain("already connected");
  expect(apiKeyField().value).toBe("");
  expect(document.body.innerHTML).not.toContain("SecretKey777");
  expect(button("Add library").disabled).toBe(true);
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("a failed check never renders the key", async () => {
  await mountDialog({
    onCheck: vi.fn().mockRejectedValue(new Error("SecretKey777 leaked")),
  });
  await fill("123456", "SecretKey777");
  await check();
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
  await click(button("Check key"));
  typeInto(libraryIdField(), "999");
  await flush(3);
  resolveCheck(okResult);
  await flush(5);

  expect(button("Add library").disabled).toBe(true);
  expect(bodyText()).not.toContain("Library verified");
});
