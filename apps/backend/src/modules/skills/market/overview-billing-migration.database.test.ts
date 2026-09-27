import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * Migration 0055 retires the `overview.billing` market setting: overviews run
 * on the system model and are billed to no team. Every other setting stays.
 */

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let data: typeof import("@sourceweft/db");
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("overview_billing");
  process.env.DATABASE_URL = isolated.url;
  data = await import("@sourceweft/db");
}, 120_000);

afterAll(async () => {
  if (data) await data.closeDatabase();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("the migration deletes the overview billing setting and nothing else", async () => {
  const migration = await readFile(
    new URL(
      "../../../../../../packages/db/drizzle/0056_remove_overview_billing_setting.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await data.db.insert(data.skillMarketSettings).values([
    {
      key: "overview.billing",
      value: { teamId: "t", workspaceId: "w", userId: "u" },
      updatedBy: "u",
    },
    { key: "analysis.quality", value: { reviewed: true }, updatedBy: null },
  ]);
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await data.database.query(statement);
  }
  const rows = await data.database.query<{ key: string }>(
    "select key from skill_market_settings order by key",
  );
  assert.deepEqual(
    rows.rows.map((row) => row.key),
    ["analysis.quality"],
  );
});
