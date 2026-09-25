import { expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

test("Files payloads and references keep their own namespace and target constraints", async () => {
  await withIsolatedSchema(
    {
      prefix: "files_schema",
      setupSql: `CREATE TABLE working_files(path text, content_text text default '', CONSTRAINT working_files_path_check CHECK(path like '/workfiles/%'));
      CREATE TABLE citations(chunk_id text, external_uri text, source_id text, document_id text, metadata_json jsonb, CONSTRAINT citations_target_check CHECK(chunk_id IS NOT NULL OR external_uri IS NOT NULL));`,
      migrations: [
        "0036_files_root.sql",
        "0037_file_payloads.sql",
        "0038_file_citations.sql",
      ],
    },
    async (client) => {
      const rejected = async (sql: string, values: unknown[]) => {
        await client.query("SAVEPOINT rejected");
        await expect(client.query(sql, values)).rejects.toBeDefined();
        await client.query("ROLLBACK TO SAVEPOINT rejected");
      };
      await client.query(
        "INSERT INTO working_files(path) VALUES('/files/empty.txt')",
      );
      await rejected("INSERT INTO working_files(path) VALUES($1)", [
        "/workfiles/old.txt",
      ]);
      await rejected(
        "INSERT INTO working_files(path,payload_kind,storage_bucket,storage_key,content_text) VALUES('/files/image.png','object','bucket','key','text must not coexist')",
        [],
      );
      await client.query(
        "INSERT INTO working_files(path,payload_kind,storage_bucket,storage_key) VALUES('/files/image.png','object','bucket','key')",
      );
      await rejected(
        "INSERT INTO working_files(path,content_hash) VALUES('/files/bad.txt','invalid')",
        [],
      );
      const reference = {
        origin: "file",
        fileReference: { file: { fileId: "file" }, locator: { kind: "image" } },
      };
      await client.query("INSERT INTO citations(metadata_json) VALUES($1)", [
        reference,
      ]);
      await rejected(
        "INSERT INTO citations(metadata_json,source_id,chunk_id) VALUES($1,'invented-source','invented-chunk')",
        [reference],
      );
      await rejected("INSERT INTO citations(metadata_json) VALUES('{}')", []);
    },
  );
});
