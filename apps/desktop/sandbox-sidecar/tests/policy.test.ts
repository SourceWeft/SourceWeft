import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfig,
  perCommandConfig,
  PolicyInvalidError,
} from "../src/policy.js";

function validInit(overrides: Partial<Parameters<typeof buildConfig>[0]> = {}) {
  return {
    platform: "linux" as const,
    home: "/home/u",
    workspaceRoots: ["/home/u/ws"],
    readRoots: ["/home/u/.nvm/versions/node/v22.1.0"],
    helpers: { ripgrep: "/opt/sw/rg" },
    ...overrides,
  };
}

test("denies home, re-allows workspace and read roots as literals", () => {
  const c = buildConfig({
    platform: "linux",
    home: "/home/u",
    workspaceRoots: ["/home/u/ws [1]"],
    readRoots: ["/home/u/.nvm/versions/node/v22.1.0"],
    helpers: { ripgrep: "/opt/sw/rg", applySeccomp: "/opt/sw/apply-seccomp" },
    bwrapPath: "/opt/sourceweft/libexec/bwrap",
  });
  assert.deepEqual(c.filesystem.denyRead, [{ path: "/home/u", literal: true }]);
  assert.deepEqual(c.filesystem.allowRead, [
    { path: "/home/u/ws [1]", literal: true },
    { path: "/home/u/.nvm/versions/node/v22.1.0", literal: true },
  ]);
  assert.deepEqual(c.filesystem.allowWrite, []);
  assert.equal(c.filesystem.allowGitConfig, true);
  assert.deepEqual(c.network.allowedDomains, []);
  assert.deepEqual(c.network.deniedResolvedAddresses, [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "fc00::/7",
  ]);
  assert.equal(c.bwrapPath, "/opt/sourceweft/libexec/bwrap");
  assert.equal(c.seccomp?.applyPath, "/opt/sw/apply-seccomp");
  for (const k of [
    "allowLocalBinding",
    "allowUnixSockets",
    "allowAllUnixSockets",
    "enableWeakerNestedSandbox",
    "allowAppleEvents",
  ])
    assert.ok(!(k in c) && !(k in c.network), `${k} must not be set`);
});
test("per-command write root is the workspace only", () =>
  assert.deepEqual(perCommandConfig("/home/u/ws [1]").filesystem?.allowWrite, [
    { path: "/home/u/ws [1]", literal: true },
  ]));

// Ruling R7 (fix round 1 review): buildConfig must reject a non-absolute home,
// workspaceRoots[] or readRoots[] entry with a PolicyInvalidError (code POLICY_INVALID, the
// matching SidecarErrorCode).
test("rejects a relative home", () => {
  assert.throws(
    () => buildConfig(validInit({ home: "home/u" })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
test("rejects a relative workspaceRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ workspaceRoots: ["ws"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
test("rejects a relative readRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ readRoots: ["../ro"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});
