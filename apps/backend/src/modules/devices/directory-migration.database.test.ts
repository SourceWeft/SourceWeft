import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, test } from "vitest";

// Transaction-scoped isolated schema. Production tables are never addressed.
test("directory grants preserve PostgreSQL target and directory immutability", async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const schema = `local_directory_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE threads(id text primary key, created_by text, visibility text default 'private', workspace_id text, team_id text);
      CREATE TABLE local_devices(id text primary key, user_id text, revoked_at timestamptz);
      CREATE TABLE local_thread_bindings(thread_id text primary key,device_id text,user_id text,local_workspace_id text,workspace_path text);
    `);
    for (const migration of [
      "0030_purple_wallow.sql",
      "0033_local_directory_grants.sql",
    ]) {
      const sql = await readFile(
        new URL(
          `../../../../../packages/db/drizzle/${migration}`,
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql);
    }
    await client.query(
      "INSERT INTO local_devices(id,user_id) VALUES('pc','owner')",
    );
    const target = {
      kind: "local",
      deviceId: "pc",
      directoryGrantId: randomUUID(),
    };
    await client.query(
      "INSERT INTO threads(id,created_by,execution_target_json) VALUES('t','owner',$1)",
      [target],
    );
    expect(
      (
        await client.query(
          "SELECT device_id FROM local_thread_bindings WHERE thread_id='t'",
        )
      ).rows[0].device_id,
    ).toBe("pc");
    await client.query(
      "UPDATE local_thread_bindings SET local_workspace_id='native',workspace_path='/Users/test/project' WHERE thread_id='t'",
    );
    const rejected = async (
      sql: string,
      params: unknown[],
      message: string,
    ) => {
      await client.query("SAVEPOINT invalid_operation");
      await expect(client.query(sql, params)).rejects.toThrow(message);
      await client.query("ROLLBACK TO SAVEPOINT invalid_operation");
    };
    await rejected(
      "UPDATE threads SET execution_target_json=$1 WHERE id='t'",
      [{ ...target, directoryGrantId: randomUUID() }],
      "EXECUTION_TARGET_IMMUTABLE",
    );
    await rejected(
      "UPDATE local_thread_bindings SET workspace_path='/Users/test/other' WHERE thread_id='t'",
      [],
      "LOCAL_WORKSPACE_IMMUTABLE",
    );
    await rejected(
      "INSERT INTO threads(id,created_by,execution_target_json) VALUES('raw','owner',$1)",
      [
        {
          kind: "local",
          deviceId: "pc",
          directoryGrantId: "/Users/test/arbitrary",
        },
      ],
      "threads_execution_target_check",
    );
    await client.query(
      "INSERT INTO threads(id,created_by,execution_target_json) VALUES('auto','owner',$1),('cloud','owner',$2)",
      [{ kind: "local", deviceId: "pc" }, { kind: "cloud" }],
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
