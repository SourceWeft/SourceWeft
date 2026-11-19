import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { config } from "./config";
import { UniqueVersionPostgresSaver } from "./unique-version-postgres-saver";

let saverPromise: Promise<PostgresSaver> | null = null;

/** Names the advisory lock that serialises checkpoint schema setup. */
const SETUP_LOCK_NAME = "sourceweft:langgraph-checkpointer-setup";

/**
 * Run the saver's schema setup under a PostgreSQL advisory lock.
 *
 * `setup()` reads the applied migration version, runs what is missing and
 * records each step. Two processes that start together both see the old
 * version, and the slower one fails on the duplicate version row. The API,
 * worker and scheduler all reach this on their first chat call, so a release
 * that carries a new saver migration (such as the `task_path` column of
 * checkpoint-postgres 1.1) would hit exactly that. Holding the lock makes the
 * second process wait, then find nothing left to do.
 */
export async function setUpCheckpointSchema(
  saver: PostgresSaver,
  pool: Pool,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      SETUP_LOCK_NAME,
    ]);
    try {
      await saver.setup();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [
        SETUP_LOCK_NAME,
      ]);
    }
  } finally {
    client.release();
  }
}

export function getChatCheckpointer() {
  if (!saverPromise) {
    const pending = (async () => {
      const pool = new Pool({ connectionString: config.databaseUrl });
      const saver = new UniqueVersionPostgresSaver(pool, undefined, {
        schema: "langgraph",
      });
      await setUpCheckpointSchema(saver, pool);
      return saver;
    })();
    saverPromise = pending;
    // A failed setup must not be cached for the life of the process: the next
    // chat call tries again.
    pending.catch(() => {
      if (saverPromise === pending) {
        saverPromise = null;
      }
    });
  }

  return saverPromise;
}
