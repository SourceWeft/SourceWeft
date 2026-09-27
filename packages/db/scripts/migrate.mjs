// Applies the Drizzle schema migrations in ../drizzle with drizzle-orm's own
// migrator — the one `drizzle-kit migrate` calls — into the same
// drizzle.__drizzle_migrations table, in one transaction.
//
// Not `drizzle-kit migrate` itself: drizzle-kit 0.31 runs the migrator under a
// progress view that swallows the error and exits 1 without printing it, so an
// operator never learned why a migration failed. This reports the PostgreSQL
// error, the failing statement and the migration it belongs to.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const MIGRATIONS_FOLDER = path.join(packageDir, "drizzle");

/** The migration whose statements include `query`, by journal tag. */
export function findMigrationTag(query, folder = MIGRATIONS_FOLDER) {
  if (typeof query !== "string") return null;
  const statement = query.trim();
  const journal = JSON.parse(
    readFileSync(path.join(folder, "meta/_journal.json"), "utf8"),
  );
  for (const { tag } of journal.entries) {
    const sql = readFileSync(path.join(folder, `${tag}.sql`), "utf8");
    if (
      sql
        .split("--> statement-breakpoint")
        .some((part) => part.trim() === statement)
    ) {
      return tag;
    }
  }
  return null;
}

/**
 * A readable report of a failed migration run: the database error with its
 * SQLSTATE code, detail and hint, and the statement and migration that failed.
 */
export function describeMigrationError(error, folder = MIGRATIONS_FOLDER) {
  // drizzle-orm wraps the driver error in a DrizzleQueryError carrying the query.
  const database = error?.cause ?? error;
  const lines = ["Schema migration failed."];
  const code = database?.code ? ` (SQLSTATE ${database.code})` : "";
  lines.push(`Error: ${database?.message ?? String(error)}${code}`);
  if (database?.detail) lines.push(`Detail: ${database.detail}`);
  if (database?.hint) lines.push(`Hint: ${database.hint}`);
  if (database?.where) lines.push(`Where: ${database.where}`);
  const query = error?.query;
  if (typeof query === "string") {
    const tag = findMigrationTag(query, folder);
    if (tag) lines.push(`Migration: ${tag}`);
    const statement = query.trim();
    lines.push(
      `Statement: ${statement.length > 500 ? `${statement.slice(0, 500)}…` : statement}`,
    );
  }
  lines.push(
    "No migration from this run was applied; the transaction was rolled back.",
  );
  return lines.join("\n");
}

async function main() {
  // Like the drizzle config: the process environment wins, and a local
  // packages/db/.env fills in what is unset.
  try {
    process.loadEnvFile(path.join(packageDir, ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required to apply schema migrations.");
    return 1;
  }
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    console.log("Applying schema migrations");
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Schema migrations are up to date");
    return 0;
  } catch (error) {
    console.error(describeMigrationError(error));
    return 1;
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
