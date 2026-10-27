// @vitest-environment jsdom
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { desktopBridge } from "./desktop-bridge";

afterEach(() => {
  delete window.__SOURCEWEFT_DESKTOP__;
});

test("preserves native IPC denial strings as actionable Error objects", async () => {
  window.__SOURCEWEFT_DESKTOP__ = {
    isDesktop: true,
    invoke: vi
      .fn()
      .mockRejectedValue(
        "open_external_url not allowed on origin [remote: http://localhost:3300/]",
      ),
    listen: vi.fn(),
  };
  await assert.rejects(
    desktopBridge.openExternalUrl("http://localhost:3300/auth/sign-in"),
    (error) =>
      error instanceof Error && error.message.includes("not allowed on origin"),
  );
});

test("passes through native Error instances", async () => {
  const error = new Error("The browser could not start");
  window.__SOURCEWEFT_DESKTOP__ = {
    isDesktop: true,
    invoke: vi.fn().mockRejectedValue(error),
    listen: vi.fn(),
  };
  await assert.rejects(
    desktopBridge.openExternalUrl("http://localhost:3300/auth/sign-in"),
    (actual) => actual === error,
  );
});

test("vault wrappers invoke the native commands with the expected argument shapes", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  window.__SOURCEWEFT_DESKTOP__ = { isDesktop: true, invoke, listen: vi.fn() };
  await desktopBridge.vaultList();
  await desktopBridge.vaultSet({
    label: "L",
    envVar: "E_VAR",
    value: "v",
    hosts: ["a.example.com"],
    acknowledgedInterception: true,
  });
  await desktopBridge.vaultRemove("id-1");
  assert.deepEqual(invoke.mock.calls, [
    ["vault_list", undefined],
    [
      "vault_set",
      {
        input: {
          label: "L",
          envVar: "E_VAR",
          value: "v",
          hosts: ["a.example.com"],
          acknowledgedInterception: true,
        },
      },
    ],
    ["vault_remove", { id: "id-1" }],
  ]);
});
