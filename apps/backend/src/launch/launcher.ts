import { parseStrictBooleanEnv } from "../shared/env";
import type { MigrationLock } from "./migration-lock";

/**
 * `launch.js` commands. `prepare` is the image entrypoint's step before any
 * container command: migrate (or, with `MIGRATION_ENABLED=false`, only check).
 * `migrate` always migrates. The service names start that service and nothing
 * else — preparing the database is the entrypoint's job — and remain so that
 * deployments started as `launch.js <service>` keep working.
 */
export const LAUNCH_COMMANDS = [
  "prepare",
  "migrate",
  "api",
  "worker",
  "scheduler",
] as const;
export type LaunchCommand = (typeof LAUNCH_COMMANDS)[number];
export type LaunchService = Exclude<LaunchCommand, "prepare" | "migrate">;

export function parseLaunchCommand(value: string | undefined): LaunchCommand {
  const command = LAUNCH_COMMANDS.find((candidate) => candidate === value);
  if (!command) {
    throw new Error(
      `Unknown launch command "${value ?? ""}"; expected one of: ${LAUNCH_COMMANDS.join(", ")}.`,
    );
  }
  return command;
}

export class PendingMigrationsError extends Error {
  constructor(pending: string[]) {
    super(
      `MIGRATION_ENABLED is false and the database is missing ${pending.length} migration(s): ${pending.join(", ")}. Run the migrate command first.`,
    );
    this.name = "PendingMigrationsError";
  }
}

export type LauncherDependencies = {
  acquireLock(): Promise<MigrationLock>;
  listPendingMigrations(lock: MigrationLock): Promise<string[]>;
  log(message: string): void;
  runMigrations(): Promise<void>;
  startService(service: LaunchService): Promise<number>;
};

/**
 * Under the migration lock, applies pending migrations (`migrate: true`) or
 * refuses while any are pending, then releases the lock.
 */
async function prepareDatabase(
  deps: LauncherDependencies,
  migrate: boolean,
): Promise<void> {
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
}

/** Runs a `launch.js` command and returns the process exit code. */
export async function runLauncher(input: {
  command: LaunchCommand;
  deps: LauncherDependencies;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  const { command, deps } = input;
  if (command === "prepare") {
    await prepareDatabase(
      deps,
      parseStrictBooleanEnv("MIGRATION_ENABLED", true, input.env),
    );
    return 0;
  }
  if (command === "migrate") {
    await prepareDatabase(deps, true);
    return 0;
  }
  return deps.startService(command);
}
