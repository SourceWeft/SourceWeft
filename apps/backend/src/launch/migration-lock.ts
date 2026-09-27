import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

/**
 * The PostgreSQL advisory lock every backend role takes before migrating or
 * checking migrations. It is a session lock: it belongs to the launcher's own
 * connection, so a launcher that dies — crash, SIGKILL, lost network — releases
 * it with that connection, with no expiry to tune or renew.
 */
export const MIGRATION_LOCK_KEY = 5_356_243_781_020_437n;

export type MigrationLock = {
  /** The connection holding the lock, for queries made under it. */
  client: Pick<Client, "query">;
  release(): Promise<void>;
};

export class MigrationLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the database migration lock; another instance may be stuck migrating.`,
    );
    this.name = "MigrationLockTimeoutError";
  }
}

/**
 * Connects and takes the migration lock, retrying both until `timeoutMs`: the
 * database may still be starting, and another instance may be migrating.
 */
export async function acquireMigrationLock(input: {
  connectionString: string;
  onWaiting?: (reason: "database" | "lock") => void;
  pollMs?: number;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<MigrationLock> {
  const deadline = Date.now() + input.timeoutMs;
  const pollMs = input.pollMs ?? 1_000;
  let reportedDatabase = false;
  let reportedLock = false;

  while (true) {
    input.signal?.throwIfAborted();
    const client = new Client({
      application_name: "sourceweft-migration-lock",
      connectionString: input.connectionString,
      keepAlive: true,
    });
    // A dropped connection surfaces here; the lock went with it, and the
    // process that relied on it is about to fail on its own work.
    client.on("error", () => {});
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() >= deadline) throw error;
      if (!reportedDatabase) {
        reportedDatabase = true;
        input.onWaiting?.("database");
      }
      await delay(pollMs, undefined, { signal: input.signal });
      continue;
    }

    try {
      while (true) {
        input.signal?.throwIfAborted();
        const result = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock($1::bigint) as locked",
          [MIGRATION_LOCK_KEY.toString()],
        );
        if (result.rows[0]?.locked) {
          return {
            client,
            async release() {
              try {
                await client.query("select pg_advisory_unlock($1::bigint)", [
                  MIGRATION_LOCK_KEY.toString(),
                ]);
              } finally {
                await client.end().catch(() => {});
              }
            },
          };
        }
        if (Date.now() >= deadline) {
          throw new MigrationLockTimeoutError(input.timeoutMs);
        }
        if (!reportedLock) {
          reportedLock = true;
          input.onWaiting?.("lock");
        }
        await delay(pollMs, undefined, { signal: input.signal });
      }
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }
}
