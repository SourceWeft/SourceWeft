import { Client } from "pg";
import { inject } from "vitest";
import {
  databaseUrlFor,
  dropDatabase,
  newDatabaseName,
  requireAdminDatabaseUrl,
} from "./migrated-database";

declare module "vitest" {
  export interface ProvidedContext {
    /** Name of the migrated template database built by global-setup.ts. */
    isolatedDatabaseTemplate: string;
  }
}

/**
 * Give tests that mutate deployment-wide configuration their own database on
 * the existing PostgreSQL service, with the same extensions and migrations as
 * deployment. The schema comes from the per-run template that
 * `global-setup.ts` migrates once; each call is a CREATE DATABASE … TEMPLATE
 * clone, not a migration run. This never changes process.env or imports the
 * shared DB singleton. Callers set DATABASE_URL before importing DB modules,
 * then close their pools before calling close().
 *
 * Only runs under vitest.database.config.ts (`pnpm test:database`); there is
 * no fallback to migrating in place.
 */
export async function createIsolatedTestDatabase(label: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const adminUrl = requireAdminDatabaseUrl();
  const template = inject("isolatedDatabaseTemplate");
  if (!template) {
    throw new Error(
      "No template database was provided: run database suites with vitest.database.config.ts (pnpm test:database) so global-setup.ts can build it",
    );
  }
  const name = newDatabaseName(label);
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    // Template name comes from global-setup.ts via provide(), never from a test.
    await admin.query(`create database "${name}" template "${template}"`);
  } finally {
    await admin.end();
  }

  return {
    url: databaseUrlFor(adminUrl, name),
    close: () => dropDatabase(adminUrl, name),
  };
}
