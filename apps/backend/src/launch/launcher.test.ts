import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseLaunchCommand,
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
    startService: async (service) => {
      calls.push(`start:${service}`);
      return 0;
    },
    ...overrides,
  };
  return { calls, deps };
}

test("prepare migrates under the lock and starts nothing", async () => {
  const { calls, deps } = fakeDeps();
  assert.equal(await runLauncher({ command: "prepare", deps, env: {} }), 0);
  assert.deepEqual(calls, ["lock", "migrate", "release"]);
});

test("a failed migration releases the lock and fails prepare", async () => {
  const { calls, deps } = fakeDeps({
    runMigrations: async () => {
      calls.push("migrate");
      throw new Error("migration failed");
    },
  });
  await assert.rejects(
    runLauncher({ command: "prepare", deps, env: {} }),
    /migration failed/,
  );
  assert.deepEqual(calls, ["lock", "migrate", "release"]);
});

test("with migrations disabled, prepare only checks a current schema", async () => {
  const { calls, deps } = fakeDeps();
  const code = await runLauncher({
    command: "prepare",
    deps,
    env: { MIGRATION_ENABLED: " FALSE " },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["lock", "check", "release"]);
});

test("with migrations disabled, pending migrations fail prepare", async () => {
  const { calls, deps } = fakeDeps({ pending: ["0053_connector_sync_block"] });
  await assert.rejects(
    runLauncher({ command: "prepare", deps, env: { MIGRATION_ENABLED: "0" } }),
    (error: unknown) =>
      error instanceof PendingMigrationsError &&
      error.message.includes("0053_connector_sync_block"),
  );
  assert.deepEqual(calls, ["lock", "check", "release"]);
});

test("an invalid MIGRATION_ENABLED fails before touching the database", async () => {
  const { calls, deps } = fakeDeps();
  await assert.rejects(
    runLauncher({
      command: "prepare",
      deps,
      env: { MIGRATION_ENABLED: "yes" },
    }),
    /MIGRATION_ENABLED must be one of: true, false, 1, 0/,
  );
  assert.deepEqual(calls, []);
});

test("migrate always migrates, even with migrations disabled", async () => {
  const { calls, deps } = fakeDeps();
  const code = await runLauncher({
    command: "migrate",
    deps,
    env: { MIGRATION_ENABLED: "false" },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["lock", "migrate", "release"]);
});

test("a service command starts the service without touching the database", async () => {
  const { calls, deps } = fakeDeps({
    startService: async (service) => {
      calls.push(`start:${service}`);
      return 143;
    },
  });
  assert.equal(await runLauncher({ command: "worker", deps, env: {} }), 143);
  assert.deepEqual(calls, ["start:worker"]);
});

test("launch commands are prepare, migrate and the backend services", () => {
  assert.equal(parseLaunchCommand("prepare"), "prepare");
  assert.equal(parseLaunchCommand("scheduler"), "scheduler");
  assert.throws(
    () => parseLaunchCommand("web"),
    /Unknown launch command "web"/,
  );
  assert.throws(
    () => parseLaunchCommand(undefined),
    /Unknown launch command ""/,
  );
});
