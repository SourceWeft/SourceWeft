import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new Pool({ connectionString: url });
  pool.on("error", (err) => {
    // Prevent idle client errors from crashing the process.
    // https://node-postgres.com/apis/pool#error
    console.error(
      "[DB] idle client error (swallowed to prevent process crash):",
      (err as NodeJS.ErrnoException).code,
      err.message,
    );
  });

  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

const instance = createDb();

export const db = instance.db;
export const database = instance.pool;

export async function closeDatabase() {
  await database.end();
}

/**
 * A standalone connection for `LISTEN`. It is deliberately NOT taken from the
 * shared `Pool`: a pooled client checked out indefinitely to hold a LISTEN
 * registration would permanently shrink the pool and be torn down on pool
 * recycling. The caller owns this client's lifecycle (connect/end) and its
 * reconnection. Only `pg_notify` needs the pool; `LISTEN` needs this.
 */
export function createDedicatedClient(): Client {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  // keepAlive surfaces a dropped TCP connection as an error/end event instead of
  // a silent half-open socket that would stop delivering NOTIFY events.
  return new Client({ connectionString: url, keepAlive: true });
}
