import { expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

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
    },
  );
});
