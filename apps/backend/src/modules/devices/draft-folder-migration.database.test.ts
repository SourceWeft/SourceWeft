import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, test } from "vitest";

test("draft invocation migration accepts only explicitly scoped read actions", async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `draft_folder_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(
      "CREATE TABLE local_tool_invocations(thread_id text NOT NULL, action text NOT NULL, payload jsonb NOT NULL)",
    );
    await client.query(
      "INSERT INTO local_tool_invocations VALUES ('old-thread','file.read','{}')",
    );
    await client.query(
      await readFile(
        new URL(
          "../../../../../packages/db/drizzle/0039_draft_folder_reads.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query(
      "INSERT INTO local_tool_invocations VALUES (NULL,'folder.list','{\"folderId\":\"grant\"}'), (NULL,'folder.read','{\"folderId\":\"grant\"}')",
    );
    for (const [thread, action, payload] of [
      [null, "file.write", {}],
      [null, "folder.list", {}],
      [null, "folder.list", { folderId: null }],
      [null, "folder.list", { folderId: "" }],
      ["thread", "folder.read", { folderId: "grant" }],
    ]) {
      await client.query("SAVEPOINT invalid");
      await expect(
        client.query("INSERT INTO local_tool_invocations VALUES ($1,$2,$3)", [
          thread,
          action,
          payload,
        ]),
      ).rejects.toThrow("local_invocation_scope");
      await client.query("ROLLBACK TO SAVEPOINT invalid");
    }
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM local_tool_invocations",
        )
      ).rows[0].count,
    ).toBe(3);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
