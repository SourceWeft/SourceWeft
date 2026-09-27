import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseLaunchRole,
  PendingMigrationsError,
  runLauncher,
  type LauncherDependencies,
} from "./launcher";

function fakeDeps(
  overrides: Partial<LauncherDependencies> & { pending?: string[] } = {},
) {
  const calls: string[] = [];
  const deps: LauncherDependencies = {
    acquireLock: async () => {
      calls.push("lock");
      return {
        client: { query: async () => ({ rows: [] }) } as never,
        release: async () => {
          calls.push("release");
        },
      };
    },
    listPendingMigrations: async () => {
      calls.push("check");
      return overrides.pending ?? [];
    },
    log: () => {},
    runMigrations: async () => {
      calls.push("migrate");
    },
    startService: async (role) => {
      calls.push(`start:${role}`);
      return 0;
    },
    ...overrides,
  };
  return { calls, deps };
}

test("a role migrates under the lock and starts only after releasing it", async () => {
  const { calls, deps } = fakeDeps();
  const code = await runLauncher({ deps, env: {}, role: "api" });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["lock", "migrate", "release", "start:api"]);
});

test("the service's exit code is returned", async () => {
  const { deps } = fakeDeps({ startService: async () => 143 });
  assert.equal(await runLauncher({ deps, env: {}, role: "worker" }), 143);
});

test("the migrate role migrates and exits without starting a service", async () => {
  const { calls, deps } = fakeDeps();
  const code = await runLauncher({
    deps,
    env: { MIGRATION_ENABLED: "false" },
    role: "migrate",
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["lock", "migrate", "release"]);
});

test("a failed migration releases the lock and starts nothing", async () => {
  const { calls, deps } = fakeDeps({
    runMigrations: async () => {
      calls.push("migrate");
      throw new Error("migration failed");
    },
  });
  await assert.rejects(
    runLauncher({ deps, env: {}, role: "api" }),
    /migration failed/,
  );
  assert.deepEqual(calls, ["lock", "migrate", "release"]);
});

test("with migrations disabled, a current schema starts without migrating", async () => {
  const { calls, deps } = fakeDeps();
  const code = await runLauncher({
    deps,
    env: { MIGRATION_ENABLED: " FALSE " },
    role: "scheduler",
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["lock", "check", "release", "start:scheduler"]);
});

test("with migrations disabled, pending migrations stop the role", async () => {
  const { calls, deps } = fakeDeps({ pending: ["0053_connector_sync_block"] });
  await assert.rejects(
    runLauncher({ deps, env: { MIGRATION_ENABLED: "0" }, role: "api" }),
    (error: unknown) =>
      error instanceof PendingMigrationsError &&
      error.message.includes("0053_connector_sync_block"),
  );
  assert.deepEqual(calls, ["lock", "check", "release"]);
});

test("an invalid MIGRATION_ENABLED fails before touching the database", async () => {
  const { calls, deps } = fakeDeps();
  await assert.rejects(
    runLauncher({ deps, env: { MIGRATION_ENABLED: "yes" }, role: "api" }),
    /MIGRATION_ENABLED must be one of: true, false, 1, 0/,
  );
  assert.deepEqual(calls, []);
});

test("launch roles are the backend services and migrate", () => {
  assert.equal(parseLaunchRole("worker"), "worker");
  assert.equal(parseLaunchRole("migrate"), "migrate");
  assert.throws(() => parseLaunchRole("web"), /Unknown launch role "web"/);
  assert.throws(() => parseLaunchRole(undefined), /Unknown launch role ""/);
});
