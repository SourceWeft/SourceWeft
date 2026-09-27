import { parseStrictBooleanEnv } from "../shared/env";
import type { MigrationLock } from "./migration-lock";

export const LAUNCH_ROLES = ["api", "worker", "scheduler", "migrate"] as const;
export type LaunchRole = (typeof LAUNCH_ROLES)[number];

export function parseLaunchRole(value: string | undefined): LaunchRole {
  const role = LAUNCH_ROLES.find((candidate) => candidate === value);
  if (!role) {
    throw new Error(
      `Unknown launch role "${value ?? ""}"; expected one of: ${LAUNCH_ROLES.join(", ")}.`,
    );
  }
  return role;
}

export class PendingMigrationsError extends Error {
  constructor(pending: string[]) {
    super(
      `MIGRATION_ENABLED is false and the database is missing ${pending.length} migration(s): ${pending.join(", ")}. Run the migrate role first.`,
    );
    this.name = "PendingMigrationsError";
  }
}

export type LauncherDependencies = {
  acquireLock(): Promise<MigrationLock>;
  listPendingMigrations(lock: MigrationLock): Promise<string[]>;
  log(message: string): void;
  runMigrations(): Promise<void>;
  startService(role: Exclude<LaunchRole, "migrate">): Promise<number>;
};

/**
 * Starts a backend role on a migrated database. Under the migration lock, the
 * role applies pending migrations (`MIGRATION_ENABLED`, default true) or, with
 * migrations disabled, refuses to start while any are pending. The `migrate`
 * role always migrates and then exits. Only after the lock is released does a
 * service start; its exit code is returned.
 */
export async function runLauncher(input: {
  deps: LauncherDependencies;
  env: NodeJS.ProcessEnv;
  role: LaunchRole;
}): Promise<number> {
  const { deps, role } = input;
  const migrate =
    role === "migrate" ||
    parseStrictBooleanEnv("MIGRATION_ENABLED", true, input.env);

  const lock = await deps.acquireLock();
  try {
    if (migrate) {
      const startedAt = Date.now();
      deps.log("Applying database migrations");
      await deps.runMigrations();
      deps.log(`Database migrations complete in ${Date.now() - startedAt}ms`);
    } else {
      const pending = await deps.listPendingMigrations(lock);
      if (pending.length > 0) throw new PendingMigrationsError(pending);
      deps.log("Database schema is current; migrations are disabled");
    }
  } finally {
    await lock.release();
  }

  if (role === "migrate") return 0;
  deps.log(`Starting ${role}`);
  return deps.startService(role);
}
