import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfig,
  perCommandConfig,
  perWrapReadRoots,
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
    { path: "/opt/sw/apply-seccomp", literal: true },
  ]);
  assert.deepEqual(c.filesystem.allowWrite, []);
  // Ruling R15: srt's own always-writable TMPDIR is denied.
  assert.deepEqual(c.filesystem.denyWrite, [
    { path: "/tmp/claude", literal: true },
    { path: "/private/tmp/claude", literal: true },
  ]);
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
  assert.deepEqual(perCommandConfig("/home/u/ws [1]", []).filesystem?.allowWrite, [
    { path: "/home/u/ws [1]", literal: true },
  ]));

// Ruling R14: per command, only that command's workspace root plus the read roots are
// re-allowed inside the denied home — never the other init workspace roots.
test("per-command read roots are the workspace plus readRoots only", () =>
  assert.deepEqual(
    perCommandConfig("/home/u/ws [1]", ["/home/u/.cargo"]).filesystem?.allowRead,
    [
      { path: "/home/u/ws [1]", literal: true },
      { path: "/home/u/.cargo", literal: true },
    ],
  ));

// The in-sandbox helpers live in the (denied) bundle directory; exactly those two files are
// re-allowed, never the bundle directory, and ripgrep (host-side only) is not.
test("per-wrap read roots carve out exactly the in-sandbox helper files", () => {
  const init = validInit({
    helpers: {
      ripgrep: "/home/u/app/sandbox/current/rg",
      applySeccomp: "/home/u/app/sandbox/current/apply-seccomp",
      javaAgentJar: "/home/u/app/sandbox/current/srt-proxy-agent.jar",
    },
  });
  assert.deepEqual(perWrapReadRoots(init), [
    "/home/u/.nvm/versions/node/v22.1.0",
    "/home/u/app/sandbox/current/apply-seccomp",
    "/home/u/app/sandbox/current/srt-proxy-agent.jar",
  ]);
  assert.deepEqual(perWrapReadRoots(validInit()), ["/home/u/.nvm/versions/node/v22.1.0"]);
});

// Ruling R16(c): extra read denies come after `home`, as literals; omitted means none.
test("denyRoots are added to denyRead as literals", () => {
  const c = buildConfig(
    validInit({ denyRoots: ["/home/u/.local/share/app/local-host", "/home/u/.local/share/app/sandbox"] }),
  );
  assert.deepEqual(c.filesystem.denyRead, [
    { path: "/home/u", literal: true },
    { path: "/home/u/.local/share/app/local-host", literal: true },
    { path: "/home/u/.local/share/app/sandbox", literal: true },
  ]);
  assert.deepEqual(buildConfig(validInit()).filesystem.denyRead, [
    { path: "/home/u", literal: true },
  ]);
});
test("rejects a relative denyRoots entry", () => {
  assert.throws(
    () => buildConfig(validInit({ denyRoots: ["local-host"] })),
    (error) => {
      assert.ok(error instanceof PolicyInvalidError);
      assert.equal(error.code, "POLICY_INVALID");
      return true;
    },
  );
});

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
