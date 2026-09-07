import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

/**
 * Give tests that mutate deployment-wide configuration their own database on
 * the existing PostgreSQL service, using the same extensions and migrations as
 * deployment. This never changes process.env or imports the shared DB singleton.
 * Callers set DATABASE_URL before importing DB modules, then close their pools
 * before calling close(). CREATE DATABASE permission is required explicitly.
 */
export async function createIsolatedTestDatabase(label: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl)
    throw new Error("DATABASE_URL is required for PostgreSQL tests");
  if (!/^[a-z0-9_]{1,16}$/.test(label)) {
    throw new Error(
      "Isolated database test label must use 1-16 lowercase letters, digits or underscores",
    );
  }
  const databaseName = `sourceweft_${label}_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const repositoryRoot = fileURLToPath(
    new URL("../../../../", import.meta.url),
  );
  const admin = new Client({ connectionString: originalUrl });
  let created = false;
  try {
    await admin.connect();
    // Fixed prefix, validated label, UUID hex: no user-controlled SQL identifier.
    await admin.query(`create database "${databaseName}"`);
    created = true;
    const initializer = new Client({ connectionString: isolatedUrl.href });
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
          env: { ...process.env, DATABASE_URL: isolatedUrl.href },
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
    if (created) await admin.query(`drop database "${databaseName}"`);
    throw error;
  } finally {
    await admin.end();
  }

  return {
    url: isolatedUrl.href,
    async close() {
      const cleanup = new Client({ connectionString: originalUrl });
      try {
        await cleanup.connect();
        await cleanup.query(`drop database "${databaseName}"`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
