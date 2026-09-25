import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

export type ProvisionedDatabase = {
  /** Connection URL of the new database. */
  url: string;
  /** Bare database name, usable as a CREATE DATABASE … TEMPLATE source. */
  name: string;
  /** Drops the database. Callers close their own pools first. */
  close: () => Promise<void>;
};

export function requireAdminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for PostgreSQL tests");
  return url;
}

/** Fixed prefix, validated label, UUID hex: no user-controlled SQL identifier. */
export function newDatabaseName(label: string): string {
  if (!/^[a-z0-9_]{1,16}$/.test(label)) {
    throw new Error(
      "Isolated database test label must use 1-16 lowercase letters, digits or underscores",
    );
  }
  return `sourceweft_${label}_${randomUUID().replaceAll("-", "")}`;
}

export function databaseUrlFor(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.href;
}

export async function dropDatabase(
  adminUrl: string,
  name: string,
): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`drop database "${name}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Create a database on the existing PostgreSQL service and bring it to the
 * deployment schema: the same extensions and the full migration chain
 * (`migrate:auth`, drizzle, `auth:provision-extension`), three cold
 * subprocesses. This never changes process.env or imports the shared DB
 * singleton. CREATE DATABASE permission is required explicitly.
 *
 * Slow by design. Scripts that need a standalone environment call this
 * directly; vitest suites get the same schema through
 * `createIsolatedTestDatabase`, which clones the per-run template that
 * `global-setup.ts` builds with this function.
 */
export async function provisionMigratedDatabase(
  label: string,
): Promise<ProvisionedDatabase> {
  const adminUrl = requireAdminDatabaseUrl();
  const name = newDatabaseName(label);
  const url = databaseUrlFor(adminUrl, name);
  const repositoryRoot = fileURLToPath(
    new URL("../../../../", import.meta.url),
  );
  const admin = new Client({ connectionString: adminUrl });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database "${name}"`);
    created = true;
    const initializer = new Client({ connectionString: url });
    try {
      await initializer.connect();
      await initializer.query(
        await readFile(
          join(
            repositoryRoot,
            "docker/sourceweft-postgres/initdb/001_extensions.sql",
          ),
          "utf8",
        ),
      );
    } finally {
      await initializer.end();
    }
    try {
      await promisify(execFile)(
        "pnpm",
        ["--filter", "@sourceweft/backend", "db:migrate"],
        {
          cwd: repositoryRoot,
          env: { ...process.env, DATABASE_URL: url },
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Failed to migrate isolated test database: ${output.stdout ?? ""}\n${output.stderr ?? output.message}`,
      );
    }
  } catch (error) {
    if (created) await admin.query(`drop database "${name}"`);
    throw error;
  } finally {
    await admin.end();
  }

  return { url, name, close: () => dropDatabase(adminUrl, name) };
}
