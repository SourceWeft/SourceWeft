import assert from "node:assert/strict";
import {
  CompositeBackend,
  StateBackend,
  createFilesystemMiddleware,
  type SandboxBackendProtocolV2,
} from "deepagents";
import { test } from "vitest";
import {
  createDefaultFilesystemMounts,
  createSandboxFilesystemMount,
  filesystemPermissionsForMounts,
} from "./filesystem-capabilities";

function sandboxBackend(): SandboxBackendProtocolV2 {
  return Object.assign(new StateBackend(), {
    id: "filesystem-permission-test-sandbox",
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
  }) as unknown as SandboxBackendProtocolV2;
}

test("non-executable filesystem permissions encode mount capabilities with terminal deny", () => {
  const permissions = filesystemPermissionsForMounts(
    createDefaultFilesystemMounts({ skillsEnabled: true }),
  );

  assert.deepEqual(permissions.slice(-2), [
    { operations: ["read"], paths: ["/**"], mode: "deny" },
    { operations: ["write"], paths: ["/**"], mode: "deny" },
  ]);
  assert.ok(
    permissions.some(
      (rule) =>
        rule.mode === "allow" &&
        rule.operations.includes("read") &&
        rule.paths.includes("/kb/**"),
    ),
  );
  assert.ok(
    permissions.some(
      (rule) =>
        rule.mode === "deny" &&
        rule.operations.includes("write") &&
        rule.paths.includes("/kb/**"),
    ),
  );
});

test("executable permissions satisfy Deep Agents route scoping", () => {
  const sandbox = sandboxBackend();
  const backend = new CompositeBackend(sandbox, {
    "/conversation_history/": new StateBackend(),
    "/large_tool_results/": new StateBackend(),
    "/kb/": new StateBackend(),
    "/workfiles/": new StateBackend(),
    "/skills/": new StateBackend(),
    "/workspace/": sandbox,
    "/": sandbox,
  });
  const permissions = filesystemPermissionsForMounts([
    ...createDefaultFilesystemMounts({ skillsEnabled: true }),
    createSandboxFilesystemMount({ root: "/workspace" }),
  ]);

  assert.doesNotThrow(() =>
    createFilesystemMiddleware({ backend, permissions }),
  );
  const backendWithoutRootRoute = new CompositeBackend(sandbox, {
    "/workspace/": sandbox,
  });
  assert.throws(
    () =>
      createFilesystemMiddleware({
        backend: backendWithoutRootRoute,
        permissions: [
          { operations: ["read"], paths: ["/unrouted/**"], mode: "deny" },
        ],
      }),
    /Filesystem permissions cannot be used with a backend that supports command execution/u,
  );
});

test("a root-scoped sandbox remains valid under Deep Agents permissions", () => {
  const sandbox = sandboxBackend();
  const backend = new CompositeBackend(sandbox, {
    "/conversation_history/": new StateBackend(),
    "/large_tool_results/": new StateBackend(),
    "/kb/": new StateBackend(),
    "/workfiles/": new StateBackend(),
    "/": sandbox,
  });
  const permissions = filesystemPermissionsForMounts([
    ...createDefaultFilesystemMounts(),
    createSandboxFilesystemMount({ root: "/" }),
  ]);

  assert.doesNotThrow(() =>
    createFilesystemMiddleware({ backend, permissions }),
  );
});
