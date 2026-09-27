import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../shared/logger";
import { findBackendPackageRoot } from "../shared/runtime-paths";
import {
  parseLaunchCommand,
  runLauncher,
  type LaunchCommand,
} from "./launcher";
import { runHealthCommand } from "./health";
import { acquireMigrationLock } from "./migration-lock";
import { listPendingSchemaMigrations } from "./pending-migrations";

// `node dist/launch.js <command>`: `prepare` is the image entrypoint's database
// step (docker/runtime-entrypoint.mjs), `migrate` the explicit migration,
// `api`/`worker`/`scheduler` start dist/<service>.js, built next to this file,
// and `health <worker|scheduler>` is their container health check.

/** How long a command waits for the database and the migration lock. */
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

async function main(command: LaunchCommand) {
  return runLauncher({
    command,
    env: process.env,
    deps: {
      acquireLock: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error("DATABASE_URL is required to prepare the database");
        }
        return acquireMigrationLock({
          connectionString,
          signal: shutdown.signal,
          timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
          onWaiting: (reason) =>
            logger.info(
              reason === "database"
                ? "Waiting for the database to accept connections"
                : "Waiting for another instance to finish database migrations",
              { command },
            ),
        });
      },
      listPendingMigrations: (lock) =>
        listPendingSchemaMigrations({
          client: lock.client,
          journalPath: path.join(
            backendRoot!,
            "../../packages/db/drizzle/meta/_journal.json",
          ),
        }),
      log: (message) => logger.info(message, { command }),
      runMigrations: async () => {
        const code = await run("pnpm", ["run", "db:migrate"], {
          cwd: backendRoot!,
        });
        shutdown.signal.throwIfAborted();
        if (code !== 0) {
          throw new Error(`Database migration failed (exit code ${code})`);
        }
      },
      startService: (service) => {
        shutdown.signal.throwIfAborted();
        return run(process.execPath, [path.join(distDir, `${service}.js`)], {});
      },
    },
  });
}

if (process.argv[2] === "health") {
  const { code, message } = runHealthCommand(process.argv[3]);
  (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
} else {
  try {
    process.exitCode = await main(parseLaunchCommand(process.argv[2]));
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
}
