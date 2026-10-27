// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const bridge = {
  available: true,
  vaultList: vi.fn(),
  vaultSet: vi.fn(),
  vaultRemove: vi.fn(),
};

vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    isAvailable: () => bridge.available,
    vaultList: (...a: unknown[]) => bridge.vaultList(...a),
    vaultSet: (...a: unknown[]) => bridge.vaultSet(...a),
    vaultRemove: (...a: unknown[]) => bridge.vaultRemove(...a),
  },
}));

import { LocalVaultSection } from "./local-vault-section";
import { button, flush, mountWithIntl, typeInto, unmountAll } from "@/test/react";

const SECRET_VALUE = "ghp_super_secret_value_123";

function meta(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: "GitHub",
    envVar: "GITHUB_TOKEN",
    hosts: ["api.github.com", "uploads.github.com"],
    readOnly: true,
    createdAt: 1_790_000_000,
    ...over,
  };
}

async function render() {
  const handle = await mountWithIntl(createElement(LocalVaultSection));
  await flush(6);
  return handle.container;
}

function field(container: HTMLElement, label: RegExp) {
  const labelNode = [...container.querySelectorAll("label")].find((l) =>
    label.test(l.textContent ?? ""),
  );
  assert.ok(labelNode, `field ${label}`);
  return labelNode.querySelector("input,textarea") as
    | HTMLInputElement
    | HTMLTextAreaElement;
}

async function tickConsent(container: HTMLElement) {
  await act(async () => {
    (container.querySelector('[data-testid="vault-consent"] input') as HTMLInputElement).click();
  });
}

async function fillForm(container: HTMLElement) {
  await act(async () => {
    typeInto(field(container, /^Label/), "GitHub");
    typeInto(field(container, /^Environment variable/), "GITHUB_TOKEN");
    typeInto(field(container, /^Secret value/), SECRET_VALUE);
    typeInto(field(container, /^Hosts/), "api.github.com\nuploads.github.com\n");
  });
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
  });
  await flush(6);
}

beforeEach(() => {
  bridge.available = true;
  bridge.vaultList.mockReset();
  bridge.vaultSet.mockReset();
  bridge.vaultRemove.mockReset();
});
afterEach(unmountAll);

test("is hidden without a desktop bridge", async () => {
  bridge.available = false;
  const container = await render();
  assert.equal(container.innerHTML, "");
  assert.equal(bridge.vaultList.mock.calls.length, 0);
});

test("is hidden when the native side lacks the vault commands or the platform", async () => {
  for (const failure of [
    new Error("Command vault_list not found"),
    new Error("UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux."),
    new TypeError("desktopBridge.vaultList is not a function"),
  ]) {
    bridge.vaultList.mockReset();
    bridge.vaultList.mockRejectedValue(failure);
    const container = await render();
    assert.equal(container.innerHTML, "", String(failure));
    await unmountAll();
  }
});

test("a permission denial is shown as an error, never hidden", async () => {
  bridge.vaultList.mockRejectedValue(
    new Error("vault_list not allowed on window main, Command not found"),
  );
  const container = await render();
  assert.ok(container.querySelector('[data-testid="vault-section"]'));
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Could not read the secrets/);
});

test("lists secrets with env name, hosts and the write-approval badge, never a value", async () => {
  bridge.vaultList.mockResolvedValue({
    secrets: [meta("s1"), meta("s2", { label: "Open", envVar: "OPEN_KEY", readOnly: false })],
    enforced: true,
  });
  const container = await render();
  const rows = container.querySelectorAll('[data-testid="vault-secret"]');
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent ?? "", /GitHub/);
  assert.match(rows[0]!.textContent ?? "", /GITHUB_TOKEN/);
  assert.match(rows[0]!.textContent ?? "", /api\.github\.com, uploads\.github\.com/);
  assert.match(rows[0]!.textContent ?? "", /Writes need approval/);
  assert.doesNotMatch(rows[1]!.textContent ?? "", /Writes need approval/);
  assert.equal(container.querySelector('[role="status"]'), null);
});

test("shows a notice when secrets are stored but not injected here", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: false });
  const container = await render();
  assert.match(
    container.querySelector('[role="status"]')?.textContent ?? "",
    /does not inject them into commands yet/,
  );
});

test("saving needs the consent tick; the value is sent with the acknowledgement, then the field is cleared", async () => {
  bridge.vaultList
    .mockResolvedValueOnce({ secrets: [], enforced: true })
    .mockResolvedValueOnce({ secrets: [meta("s1")], enforced: true });
  bridge.vaultSet.mockResolvedValue(meta("s1"));
  const container = await render();
  await act(async () => button("Add secret", container).click());
  const consent = container.querySelector('[data-testid="vault-consent"]')?.textContent ?? "";
  assert.match(consent, /decrypts the HTTPS traffic of commands running on this computer/);
  assert.match(consent, /Every command on this computer receives all stored secrets as placeholders/);
  assert.match(consent, /reachable even in the strict and ask network modes/);
  assert.match(consent, /that one request \(method and path\) send the secret/);
  assert.match(consent, /request whose body contains a secret always asks/);
  assert.match(consent, /writes to these hosts are not gated/);
  const save = button("Save secret", container);
  assert.equal(save.disabled, true);
  await fillForm(container);
  // Even a forced submit is refused without the acknowledgement.
  await submit(container);
  assert.equal(bridge.vaultSet.mock.calls.length, 0);

  await tickConsent(container);
  assert.equal(button("Save secret", container).disabled, false);
  await submit(container);

  assert.deepEqual(bridge.vaultSet.mock.calls[0], [
    {
      label: "GitHub",
      envVar: "GITHUB_TOKEN",
      value: SECRET_VALUE,
      hosts: ["api.github.com", "uploads.github.com"],
      readOnly: true,
      acknowledgedInterception: true,
    },
  ]);
  // Back to the list: the form (and its value field) is gone, and the value
  // appears nowhere in the DOM.
  assert.equal(container.querySelector("form"), null);
  assert.equal(container.innerHTML.includes(SECRET_VALUE), false);
  assert.equal(container.querySelectorAll('[data-testid="vault-secret"]').length, 1);
});

test("the value field is a password input and consent is required for every secret", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: true });
  const container = await render();
  await act(async () => button("Add secret", container).click());
  assert.equal(field(container, /^Secret value/).type, "password");
  assert.ok(container.querySelector('[data-testid="vault-consent"]'));
  assert.equal(button("Save secret", container).disabled, true);
});

test("hosts are exact names: the help says so and a wildcard gets a hint", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [], enforced: true });
  const container = await render();
  await act(async () => button("Add secret", container).click());
  assert.match(container.textContent ?? "", /Exact host names only/);
  assert.equal(container.querySelector('[role="note"]'), null);
  await act(async () => typeInto(field(container, /^Hosts/), "*.github.com"));
  assert.match(container.querySelector('[role="note"]')?.textContent ?? "", /Wildcards are not supported/);
});

test("write approval defaults on and can be switched off", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: true });
  bridge.vaultSet.mockResolvedValue(meta("s2"));
  const container = await render();
  await act(async () => button("Add secret", container).click());
  const box = field(container, /^Require approval/) as HTMLInputElement;
  assert.equal(box.checked, true);
  await act(async () => box.click());
  await fillForm(container);
  await tickConsent(container);
  await submit(container);
  assert.equal(
    (bridge.vaultSet.mock.calls[0]![0] as { readOnly: boolean }).readOnly,
    false,
  );
});

test("a native validation error is shown verbatim and the entered value stays for a retry", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: true });
  bridge.vaultSet.mockRejectedValue(
    new Error("PATH is reserved by the sandbox and cannot hold a secret."),
  );
  const container = await render();
  await act(async () => button("Add secret", container).click());
  await fillForm(container);
  await tickConsent(container);
  await submit(container);
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /PATH is reserved by the sandbox/,
  );
  assert.ok(container.querySelector("form"));
  assert.equal(container.innerHTML.includes(SECRET_VALUE), false);
  assert.equal(container.querySelectorAll('[data-testid="vault-secret"]').length, 1);
});

test("cancel empties the form including the value", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: true });
  const container = await render();
  await act(async () => button("Add secret", container).click());
  await fillForm(container);
  await act(async () => button("Cancel", container).click());
  await act(async () => button("Add secret", container).click());
  assert.equal(field(container, /^Secret value/).value, "");
  assert.equal(field(container, /^Label/).value, "");
});

test("removing needs a confirmation and then refreshes the list", async () => {
  bridge.vaultList
    .mockResolvedValueOnce({ secrets: [meta("s1")], enforced: true })
    .mockResolvedValueOnce({ secrets: [], enforced: true });
  bridge.vaultRemove.mockResolvedValue(undefined);
  const container = await render();
  await act(async () => button("Remove", container).click());
  assert.equal(bridge.vaultRemove.mock.calls.length, 0);
  assert.match(container.textContent ?? "", /Remove GitHub\?/);
  // Cancel keeps it.
  await act(async () => button("Cancel", container).click());
  assert.equal(bridge.vaultRemove.mock.calls.length, 0);
  await act(async () => button("Remove", container).click());
  await act(async () => button("Remove secret", container).click());
  await flush(6);
  assert.deepEqual(bridge.vaultRemove.mock.calls[0], ["s1"]);
  assert.equal(container.querySelectorAll('[data-testid="vault-secret"]').length, 0);
  assert.match(container.textContent ?? "", /No secrets stored/);
});

test("a failed remove keeps the secret and shows the error", async () => {
  bridge.vaultList.mockResolvedValue({ secrets: [meta("s1")], enforced: true });
  bridge.vaultRemove.mockRejectedValue(new Error("Keychain is locked"));
  const container = await render();
  await act(async () => button("Remove", container).click());
  await act(async () => button("Remove secret", container).click());
  await flush(6);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Keychain is locked/);
  assert.equal(container.querySelectorAll('[data-testid="vault-secret"]').length, 1);
});

test("an unexpected list failure keeps the section and says so", async () => {
  bridge.vaultList.mockRejectedValue(new Error("database is locked"));
  const container = await render();
  assert.match(container.textContent ?? "", /Could not read the secrets/);
  assert.ok(container.querySelector('[data-testid="vault-section"]'));
});
