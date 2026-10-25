// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SandboxReadiness } from "../../../../lib/desktop-bridge";

const installSandboxRuntime = vi.fn();
const runSandboxPrivilegedSetup = vi.fn();

vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    installSandboxRuntime: () => installSandboxRuntime(),
    runSandboxPrivilegedSetup: () => runSandboxPrivilegedSetup(),
  },
}));

import { LocalSandboxSetupCard } from "./local-sandbox-setup-card";
import {
  button,
  buttons,
  click,
  flush,
  mountWithIntl,
  unmountAll,
} from "@/test/react";

const needs = (
  remedy: Extract<SandboxReadiness, { state: "needsSetup" }>["remedy"],
  extra: Partial<Extract<SandboxReadiness, { state: "needsSetup" }>> = {},
): SandboxReadiness => ({
  state: "needsSetup",
  code: "bundleMissing",
  reason: "The sandbox runtime is not installed.",
  remedy,
  ...extra,
});

const onChanged = vi.fn();
async function render(readiness: SandboxReadiness | undefined) {
  const { container } = await mountWithIntl(
    createElement(LocalSandboxSetupCard, { readiness, onChanged }),
  );
  return container;
}

beforeEach(() => {
  installSandboxRuntime.mockReset();
  runSandboxPrivilegedSetup.mockReset();
  onChanged.mockReset();
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

test("nothing renders unless the host reports needsSetup", async () => {
  for (const readiness of [
    undefined,
    { state: "ready" } as const,
    { state: "unsupported" } as const,
  ]) {
    const container = await render(readiness);
    assert.equal(container.textContent, "");
    await unmountAll();
  }
});

test("downloadRuntime shows the reason and installs on click, then applies the new readiness", async () => {
  const next: SandboxReadiness = { state: "ready", toolchainPath: "system" };
  installSandboxRuntime.mockResolvedValue(next);
  const container = await render(needs("downloadRuntime"));
  assert.match(container.textContent ?? "", /Set up local execution/);
  assert.match(
    container.textContent ?? "",
    /The sandbox runtime is not installed\./,
  );
  assert.equal(installSandboxRuntime.mock.calls.length, 0);
  await click(button("Install sandbox runtime", container));
  assert.equal(installSandboxRuntime.mock.calls.length, 1);
  assert.deepEqual(onChanged.mock.calls[0], [next]);
});

test("an install failure is shown verbatim and keeps the button usable", async () => {
  installSandboxRuntime.mockRejectedValue(
    new Error("SANDBOX_SIGNATURE_INVALID: bad signature"),
  );
  const container = await render(needs("downloadRuntime"));
  await click(button("Install sandbox runtime", container));
  await flush(3);
  const alert = container.querySelector('[role="alert"]');
  assert.equal(alert?.textContent, "SANDBOX_SIGNATURE_INVALID: bad signature");
  assert.equal(onChanged.mock.calls.length, 0);
  assert.equal(button("Install sandbox runtime", container).disabled, false);
});

test("the install button is busy while the download runs", async () => {
  let finish: (value: SandboxReadiness) => void = () => {};
  installSandboxRuntime.mockReturnValue(
    new Promise<SandboxReadiness>((resolve) => {
      finish = resolve;
    }),
  );
  const container = await render(needs("downloadRuntime"));
  await click(button("Install sandbox runtime", container));
  const busy = button("Installing…", container);
  assert.equal(busy.disabled, true);
  finish({ state: "ready" });
  await flush(3);
  assert.ok(button("Install sandbox runtime", container));
});

test("updateApp points to Settings → About and offers no install", async () => {
  const container = await render(needs("updateApp", { code: "bundleNewer" }));
  assert.match(container.textContent ?? "", /Settings → About/);
  assert.equal(buttons("Install sandbox runtime", container).length, 0);
});

test("reinstallPackage explains the .deb / bubblewrap fix", async () => {
  const container = await render(
    needs("reinstallPackage", { code: "bwrapMissing" }),
  );
  assert.match(container.textContent ?? "", /\.deb/);
  assert.match(container.textContent ?? "", /bubblewrap/);
  assert.equal(buttons("Run setup", container).length, 0);
});

test("privilegedSetup shows the exact command read-only, copies it, and runs setup", async () => {
  const command = "pkexec /bin/sh -c 'echo \"x\"' sh install";
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  runSandboxPrivilegedSetup.mockResolvedValue(undefined);
  const container = await render(
    needs("privilegedSetup", {
      code: "userNamespaceRestricted",
      setupCommand: command,
    }),
  );
  const block = container.querySelector("pre code");
  assert.equal(block?.textContent, command);
  assert.equal(container.querySelectorAll("textarea, input").length, 0);
  await click(button("Copy", container));
  assert.deepEqual(writeText.mock.calls[0], [command]);
  assert.ok(button("Copied", container));
  await click(button("Run setup", container));
  assert.equal(runSandboxPrivilegedSetup.mock.calls.length, 1);
  assert.equal(onChanged.mock.calls.length, 1);
});

test("a privileged setup failure is shown verbatim", async () => {
  runSandboxPrivilegedSetup.mockRejectedValue(
    new Error("SANDBOX_SETUP_CANCELLED: authorization dismissed"),
  );
  const container = await render(
    needs("privilegedSetup", { setupCommand: "pkexec x" }),
  );
  await click(button("Run setup", container));
  await flush(3);
  assert.equal(
    container.querySelector('[role="alert"]')?.textContent,
    "SANDBOX_SETUP_CANCELLED: authorization dismissed",
  );
});

test("remedy none shows the reason only, plus a re-check", async () => {
  const container = await render(
    needs("none", { code: "sandboxFailed", reason: "bwrap: exploded" }),
  );
  assert.match(container.textContent ?? "", /bwrap: exploded/);
  assert.equal(buttons("Install sandbox runtime", container).length, 0);
  assert.equal(buttons("Run setup", container).length, 0);
  await click(button("Check again", container));
  assert.equal(onChanged.mock.calls.length, 1);
});

test("an install already running shows progress and no actions", async () => {
  const container = await render(
    needs("none", { code: "installing", reason: "Installing the runtime." }),
  );
  assert.match(container.textContent ?? "", /being installed/);
  assert.equal(container.querySelectorAll("button").length, 0);
});
