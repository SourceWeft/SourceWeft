import "dotenv/config";
import type { TestProject } from "vitest/node";
import { provisionMigratedDatabase } from "./migrated-database";

/**
 * Runs once per `pnpm test:database` invocation, in the main process, before
 * any fork starts: migrate one template database, hand its name to the
 * workers, drop it after the run. Every createIsolatedTestDatabase() call
 * then clones the template instead of repeating the migration chain.
 */
export default async function setup(project: TestProject) {
  const template = await provisionMigratedDatabase("template");
  project.provide("isolatedDatabaseTemplate", template.name);
  return async () => {
    await template.close();
  };
}
