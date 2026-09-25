import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

describe("directory-migration", () => {
  // Transaction-scoped isolated schema. Production tables are never addressed.
  test("directory grants preserve PostgreSQL target and directory immutability", async () => {
    await withIsolatedSchema(
      {
        prefix: "local_directory_test",
        setupSql: `
      CREATE TABLE threads(id text primary key, created_by text, visibility text default 'private', workspace_id text, team_id text);
      CREATE TABLE local_devices(id text primary key, user_id text, revoked_at timestamptz);
      CREATE TABLE local_thread_bindings(thread_id text primary key,device_id text,user_id text,local_workspace_id text,workspace_path text);
    `,
        migrations: [
          "0030_purple_wallow.sql",
          "0033_local_directory_grants.sql",
        ],
      },
      async (client) => {
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
      },
    );
  });
});

describe("draft-folder-migration", () => {
  test("draft invocation migration accepts only explicitly scoped read actions", async () => {
    await withIsolatedSchema(
      {
        prefix: "draft_folder",
        // The pre-migration row must exist before the migration runs.
        setupSql: `CREATE TABLE local_tool_invocations(thread_id text NOT NULL, action text NOT NULL, payload jsonb NOT NULL);
      INSERT INTO local_tool_invocations VALUES ('old-thread','file.read','{}');`,
        migrations: ["0039_draft_folder_reads.sql"],
      },
      async (client) => {
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
            client.query(
              "INSERT INTO local_tool_invocations VALUES ($1,$2,$3)",
              [thread, action, payload],
            ),
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
      },
    );
  });
});
