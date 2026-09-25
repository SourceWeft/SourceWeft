import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * A throwaway schema inside one transaction on the DATABASE_URL database:
 * created, set as search_path, given the base tables in `setupSql` and then
 * the listed drizzle migration files, all rolled back at the end. Production
 * tables are never addressed, and nothing survives the test.
 */
export async function withIsolatedSchema<T>(
  input: {
    /** Identifier prefix; the schema name is `${prefix}_${uuid}`. */
    prefix: string;
    /** Base tables the migrations under test build on. */
    setupSql?: string;
    /** File names under packages/db/drizzle, applied in order. */
    migrations?: string[];
  },
  fn: (client: Client, schema: string) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const schema = `${input.prefix}_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if (input.setupSql) await client.query(input.setupSql);
    for (const name of input.migrations ?? []) {
      await client.query(
        await readFile(
          new URL(`../../../../packages/db/drizzle/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
    return await fn(client, schema);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}
