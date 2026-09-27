import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../shared/logger";
import { findBackendPackageRoot } from "../shared/runtime-paths";
import { parseLaunchRole, runLauncher, type LaunchRole } from "./launcher";
import { acquireMigrationLock } from "./migration-lock";
import { listPendingSchemaMigrations } from "./pending-migrations";

// Entry point for every backend role: `node dist/launch.js <role>`. Built next
// to dist/api.js, dist/worker.js and dist/scheduler.js, which it starts.

/** How long a role waits for the database and the migration lock. */
const MIGRATION_LOCK_TIMEOUT_MS = 10 * 60_000;

const distDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = findBackendPackageRoot(distDir);
if (!backendRoot) {
  throw new Error(`Cannot find the backend package above ${distDir}`);
}

let child: ChildProcess | null = null;
const shutdown = new AbortController();
let exitSignal: NodeJS.Signals | null = null;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Relayed repeats of one stop reach the child once each; it handles them.
    exitSignal ??= signal;
    shutdown.abort(new Error(`Received ${signal}`));
    child?.kill(signal);
  });
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null) {
  if (code !== null) return code;
  return 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0);
}

function run(command: string, args: string[], options: { cwd?: string }) {
  return new Promise<number>((resolve, reject) => {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      child = null;
      resolve(exitCodeOf(code, signal));
    });
  });
}

async function main(role: LaunchRole) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to start a backend role");
  }
  return runLauncher({
    role,
    env: process.env,
    deps: {
      acquireLock: () =>
        acquireMigrationLock({
          connectionString,
          signal: shutdown.signal,
          timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
          onWaiting: (reason) =>
            logger.info(
              reason === "database"
                ? "Waiting for the database to accept connections"
                : "Waiting for another instance to finish database migrations",
              { role },
            ),
        }),
      listPendingMigrations: (lock) =>
        listPendingSchemaMigrations({
          client: lock.client,
          journalPath: path.join(
            backendRoot!,
            "../../packages/db/drizzle/meta/_journal.json",
          ),
        }),
      log: (message) => logger.info(message, { role }),
      runMigrations: async () => {
        const code = await run("pnpm", ["run", "db:migrate"], {
          cwd: backendRoot!,
        });
        shutdown.signal.throwIfAborted();
        if (code !== 0) {
          throw new Error(`Database migration failed (exit code ${code})`);
        }
      },
      startService: (serviceRole) => {
        shutdown.signal.throwIfAborted();
        return run(
          process.execPath,
          [path.join(distDir, `${serviceRole}.js`)],
          {},
        );
      },
    },
  });
}

try {
  process.exitCode = await main(parseLaunchRole(process.argv[2]));
} catch (error) {
  if (exitSignal) {
    process.exitCode = exitCodeOf(null, exitSignal);
  } else {
    logger.error("Backend launch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
