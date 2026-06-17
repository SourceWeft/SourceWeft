import { Pool } from "pg";
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
