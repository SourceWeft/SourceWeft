import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config";
import * as schema from "./db/schema";

export const database = new Pool({
  connectionString: config.databaseUrl,
});

export const db = drizzle(database as any, {
  schema,
  casing: "snake_case",
});

export async function closeDatabase() {
  await database.end();
}
