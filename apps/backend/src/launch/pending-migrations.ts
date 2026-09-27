import { readFile } from "node:fs/promises";
import type { Client } from "pg";

type Journal = { entries: Array<{ tag: string; when: number }> };

/**
 * Schema migrations shipped in `journalPath` that the database has not applied,
 * decided the way Drizzle's migrator decides it: every migration newer than
 * the last one recorded in `drizzle.__drizzle_migrations`.
 */
export async function listPendingSchemaMigrations(input: {
  client: Pick<Client, "query">;
  journalPath: string;
}): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(input.journalPath, "utf8"),
  ) as Journal;
  let lastAppliedAt: number | null = null;
  try {
    const result = await input.client.query<{ created_at: string | number }>(
      "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1",
    );
    const row = result.rows[0];
    lastAppliedAt = row ? Number(row.created_at) : null;
  } catch (error) {
    // No schema or table yet: nothing has been applied.
    const code = (error as { code?: string }).code;
    if (code !== "3F000" && code !== "42P01") throw error;
  }
  return journal.entries
    .filter((entry) => lastAppliedAt === null || entry.when > lastAppliedAt)
    .map((entry) => entry.tag);
}
