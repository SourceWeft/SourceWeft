import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../test/isolated-database";
import {
  acquireMigrationLock,
  MigrationLockTimeoutError,
} from "./migration-lock";
import { listPendingSchemaMigrations } from "./pending-migrations";

const journalPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle/meta/_journal.json",
);

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("migration_lock");
}, 120_000);

afterAll(async () => {
  await isolated?.close();
});

function acquire(timeoutMs = 5_000) {
  return acquireMigrationLock({
    connectionString: isolated.url,
    pollMs: 50,
    timeoutMs,
  });
}

test("a second instance waits for the lock until the first releases it", async () => {
  const first = await acquire();
  let secondAcquired = false;
  const second = acquire().then((lock) => {
    secondAcquired = true;
    return lock;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(secondAcquired, false);

  await first.release();
  const lock = await second;
  assert.equal(secondAcquired, true);
  await lock.release();
});

test("waiting past the timeout fails instead of starting unmigrated", async () => {
  const holder = await acquire();
  try {
    await assert.rejects(acquire(300), MigrationLockTimeoutError);
  } finally {
    await holder.release();
  }
});

test("a holder whose connection dies releases the lock with it", async () => {
  const holder = await acquire();
  const admin = new Client({ connectionString: isolated.url });
  await admin.connect();
  try {
    // End the holder's session the way a killed process would.
    const ended = await admin.query(
      `select pg_terminate_backend(pid) as ended from pg_stat_activity
       where datname = current_database()
         and application_name = 'sourceweft-migration-lock'`,
    );
    assert.equal(ended.rowCount, 1);
    const next = await acquire();
    await next.release();
  } finally {
    await admin.end();
    await holder.release().catch(() => {});
  }
});

test("pending schema migrations are the ones newer than the last applied", async () => {
  const lock = await acquire();
  try {
    assert.deepEqual(
      await listPendingSchemaMigrations({ client: lock.client, journalPath }),
      [],
    );

    const admin = new Client({ connectionString: isolated.url });
    await admin.connect();
    try {
      const last = await admin.query<{
        id: number;
        hash: string;
        created_at: string;
      }>(
        "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1",
      );
      await admin.query(
        "delete from drizzle.__drizzle_migrations where id = $1",
        [last.rows[0]!.id],
      );
      try {
        const pending = await listPendingSchemaMigrations({
          client: lock.client,
          journalPath,
        });
        assert.equal(pending.length, 1);
      } finally {
        await admin.query(
          "insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1, $2, $3)",
          [last.rows[0]!.id, last.rows[0]!.hash, last.rows[0]!.created_at],
        );
      }
    } finally {
      await admin.end();
    }
  } finally {
    await lock.release();
  }
});

test("a database with no migration table has everything pending", async () => {
  const missing = Object.assign(new Error("relation does not exist"), {
    code: "42P01",
  });
  const pending = await listPendingSchemaMigrations({
    client: {
      query: async () => {
        throw missing;
      },
    } as never,
    journalPath,
  });
  assert.ok(pending.length > 50);
  assert.equal(pending[0], "0000_talented_phalanx");
});
