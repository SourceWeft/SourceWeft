import assert from "node:assert/strict";
import { test } from "vitest";
import type { SandboxReadiness, SandboxRemedy } from "./desktop-bridge";
import { deviceSystemLabel, sandboxSetupCard } from "./sandbox-setup";

const needs = (
  remedy: SandboxRemedy,
  extra: Partial<Extract<SandboxReadiness, { state: "needsSetup" }>> = {},
): SandboxReadiness => ({
  state: "needsSetup",
  code: "bundleMissing",
  reason: "The sandbox runtime is not installed.",
  remedy,
  ...extra,
});

test("ready, unsupported and absent readiness show no setup card", () => {
  assert.equal(sandboxSetupCard(undefined), null);
  assert.equal(sandboxSetupCard(null), null);
  assert.equal(sandboxSetupCard({ state: "ready" }), null);
  assert.equal(
    sandboxSetupCard({ state: "ready", toolchainPath: "system" }),
    null,
  );
  assert.equal(sandboxSetupCard({ state: "unsupported" }), null);
});

test.each([
  ["downloadRuntime", "install"],
  ["updateApp", "updateApp"],
  ["reinstallPackage", "reinstallPackage"],
  ["privilegedSetup", "privilegedSetup"],
  ["none", "none"],
] as const)("remedy %s maps to action %s", (remedy, action) => {
  const card = sandboxSetupCard(
    needs(remedy, {
      setupCommand: remedy === "privilegedSetup" ? "pkexec x" : undefined,
    }),
  );
  assert.equal(card?.action, action);
  assert.equal(card?.reason, "The sandbox runtime is not installed.");
});

test("the setup command is exposed only for the privileged setup remedy", () => {
  assert.equal(
    sandboxSetupCard(
      needs("privilegedSetup", {
        setupCommand: "pkexec /bin/sh -c 'x' sh install",
      }),
    )?.setupCommand,
    "pkexec /bin/sh -c 'x' sh install",
  );
  assert.equal(sandboxSetupCard(needs("privilegedSetup"))?.setupCommand, null);
  assert.equal(
    sandboxSetupCard(needs("downloadRuntime", { setupCommand: "pkexec x" }))
      ?.setupCommand,
    null,
  );
});

test("an install in progress is flagged", () => {
  const card = sandboxSetupCard(needs("none", { code: "installing" }));
  assert.equal(card?.installing, true);
  assert.equal(sandboxSetupCard(needs("downloadRuntime"))?.installing, false);
});

test("an unknown remedy from a newer host degrades to reason-only", () => {
  const card = sandboxSetupCard(needs("somethingNew" as SandboxRemedy));
  assert.equal(card?.action, "none");
});

test("prototype keys are not remedies", () => {
  for (const remedy of ["constructor", "__proto__", "toString"]) {
    assert.equal(
      sandboxSetupCard(needs(remedy as SandboxRemedy))?.action,
      "none",
    );
  }
});

test("deviceSystemLabel names known platforms and tolerates missing fields", () => {
  assert.equal(
    deviceSystemLabel({ platform: "linux", arch: "x64" }),
    "Linux x64",
  );
  assert.equal(
    deviceSystemLabel({ platform: "macos", arch: "arm64" }),
    "macOS arm64",
  );
  assert.equal(deviceSystemLabel({ platform: "linux" }), "Linux");
  assert.equal(
    deviceSystemLabel({ platform: "plan9", arch: "x64" }),
    "plan9 x64",
  );
  assert.equal(deviceSystemLabel({ platform: null, arch: "x64" }), null);
  assert.equal(deviceSystemLabel({}), null);
});
