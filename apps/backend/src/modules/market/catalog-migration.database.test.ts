import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

// The `market_*` tables as 0012 and 0014 built them. Their foreign keys name
// the `public` schema; strip it so they point into the isolated schema.
async function legacyCatalogSql() {
  const files = [
    "0012_smiling_iron_monger.sql",
    "0014_living_natasha_romanoff.sql",
  ];
  const parts = await Promise.all(
    files.map((name) =>
      readFile(
        new URL(`../../../../../packages/db/drizzle/${name}`, import.meta.url),
        "utf8",
      ),
    ),
  );
  return parts.map((sql) => sql.replaceAll('"public".', "")).join(";\n");
}

const seed = `
INSERT INTO market_items
  (id, kind, identifier, name, summary, description, status, visibility,
   owner, source_url, repo_url, metadata_json, transport, official, verified,
   desktop_only, runtime, published_at)
VALUES
  ('mcp-weather', 'mcp', 'io.github.acme/weather', 'Weather', 'Forecasts',
   'Forecasts for anywhere', 'published', 'public', 'acme',
   'https://github.com/acme/weather', 'https://github.com/acme/weather',
   '{"transport":"stdio","toolsCount":2}', 'stdio', true, false, false, 'web',
   '2026-09-01T00:00:00Z'),
  ('mcp-draft', 'mcp', 'io.github.acme/draft', 'Draft', 'In review', '',
   'reviewing', 'public', NULL, NULL, NULL, '{}', NULL, false, false, false,
   'web', NULL);
INSERT INTO market_item_versions
  (id, item_id, version, status, origin, source, manifest_json, readme_md,
   package_object_key, package_sha256, provenance_json, published_at)
VALUES
  ('v-1', 'mcp-weather', '1.0.0', 'published', 'upstream', 'registry',
   '{"version":"1.0.0"}', '# Weather', 'packages/weather.tgz', 'abc123',
   '{"source":"registry"}', '2026-09-01T00:00:00Z'),
  ('v-2', 'mcp-weather', '1.1.0', 'published', 'upstream', 'registry',
   '{"version":"1.1.0"}', NULL, NULL, NULL, '{}', '2026-09-02T00:00:00Z');
INSERT INTO market_categories (id, slug, name, description) VALUES
  ('mcp-cat-databases', 'databases', 'Databases', NULL),
  ('mcp-cat-developer-tools', 'developer-tools', 'Developer Tools', 'Tools');
INSERT INTO market_item_categories (item_id, category_id) VALUES
  ('mcp-weather', 'mcp-cat-databases'),
  ('mcp-weather', 'mcp-cat-developer-tools');
`;

describe("0054 MCP catalog rename", () => {
  test("keeps every row under the mcp_* names and renames every constraint", async () => {
    await withIsolatedSchema(
      {
        prefix: "mcp_catalog_rename",
        setupSql: `${await legacyCatalogSql()};\n${seed}`,
        migrations: ["0054_mcp_catalog_rename.sql"],
      },
      async (client, schema) => {
        const tables = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
          [schema],
        );
        expect(tables.rows.map((row) => row.table_name)).toEqual([
          "mcp_categories",
          "mcp_server_categories",
          "mcp_server_versions",
          "mcp_servers",
        ]);

        const servers = await client.query(
          "SELECT * FROM mcp_servers ORDER BY id",
        );
        expect(servers.rows).toHaveLength(2);
        expect(servers.rows[1]).toMatchObject({
          id: "mcp-weather",
          identifier: "io.github.acme/weather",
          name: "Weather",
          summary: "Forecasts",
          description: "Forecasts for anywhere",
          status: "published",
          visibility: "public",
          owner: "acme",
          repo_url: "https://github.com/acme/weather",
          metadata_json: { transport: "stdio", toolsCount: 2 },
          transport: "stdio",
          official: true,
          runtime: "web",
          published_at: new Date("2026-09-01T00:00:00Z"),
          categories_set_by: "auto",
        });
        expect(servers.rows[0]).toMatchObject({
          id: "mcp-draft",
          status: "reviewing",
          categories_set_by: "auto",
        });
        expect(Object.keys(servers.rows[0])).not.toContain("kind");

        const versions = await client.query(
          "SELECT * FROM mcp_server_versions ORDER BY id",
        );
        expect(versions.rows).toMatchObject([
          {
            id: "v-1",
            server_id: "mcp-weather",
            version: "1.0.0",
            status: "published",
            origin: "upstream",
            source: "registry",
            manifest_json: { version: "1.0.0" },
            readme_md: "# Weather",
            provenance_json: { source: "registry" },
          },
          {
            id: "v-2",
            server_id: "mcp-weather",
            version: "1.1.0",
            readme_md: null,
          },
        ]);
        const versionColumns = Object.keys(versions.rows[0]);
        expect(versionColumns).not.toContain("item_id");
        expect(versionColumns).not.toContain("package_object_key");
        expect(versionColumns).not.toContain("package_sha256");

        expect(
          (await client.query("SELECT * FROM mcp_categories ORDER BY id")).rows,
        ).toMatchObject([
          { id: "mcp-cat-databases", slug: "databases" },
          { id: "mcp-cat-developer-tools", slug: "developer-tools" },
        ]);
        expect(
          (
            await client.query(
              "SELECT * FROM mcp_server_categories ORDER BY category_id",
            )
          ).rows,
        ).toEqual([
          { server_id: "mcp-weather", category_id: "mcp-cat-databases" },
          { server_id: "mcp-weather", category_id: "mcp-cat-developer-tools" },
        ]);

        const constraints = await client.query(
          `SELECT conname FROM pg_constraint
           WHERE connamespace = $1::regnamespace AND contype IN ('p', 'u', 'f', 'c')
           ORDER BY 1`,
          [schema],
        );
        expect(constraints.rows.map((row) => row.conname)).toEqual([
          "mcp_categories_pkey",
          "mcp_categories_slug_unique",
          "mcp_server_categories_category_id_mcp_categories_id_fk",
          "mcp_server_categories_pk",
          "mcp_server_categories_server_id_mcp_servers_id_fk",
          "mcp_server_versions_origin_check",
          "mcp_server_versions_pkey",
          "mcp_server_versions_server_id_mcp_servers_id_fk",
          "mcp_server_versions_status_check",
          "mcp_servers_categories_set_by_check",
          "mcp_servers_pkey",
          "mcp_servers_status_check",
          "mcp_servers_visibility_check",
        ]);

        const indexes = await client.query(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1",
          [schema],
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          "mcp_categories_pkey",
          "mcp_categories_slug_unique",
          "mcp_server_categories_pk",
          "mcp_server_versions_pkey",
          "mcp_server_versions_server_status_idx",
          "mcp_server_versions_server_version_uq",
          "mcp_servers_browse_idx",
          "mcp_servers_identifier_uq",
          "mcp_servers_pkey",
        ]);
        expect(
          indexes.rows.find((row) => row.indexname === "mcp_servers_browse_idx")
            ?.indexdef,
        ).toMatch(/\(status, visibility, published_at DESC, id DESC\)$/);

        await client.query("SAVEPOINT invalid_owner");
        await expect(
          client.query(
            "UPDATE mcp_servers SET categories_set_by = 'sync' WHERE id = 'mcp-draft'",
          ),
        ).rejects.toThrow("mcp_servers_categories_set_by_check");
        await client.query("ROLLBACK TO SAVEPOINT invalid_owner");

        // The renamed foreign keys still cascade from the server row.
        await client.query("DELETE FROM mcp_servers WHERE id = 'mcp-weather'");
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM mcp_server_versions",
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM mcp_server_categories",
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
  });

  test("stops instead of turning a non-MCP row into a listed server", async () => {
    await expect(
      withIsolatedSchema(
        {
          prefix: "mcp_catalog_rename",
          setupSql: `${await legacyCatalogSql()};
INSERT INTO market_items (id, kind, identifier, name, status, visibility)
VALUES ('skill-1', 'skill', 'acme/skill', 'Skill', 'published', 'public');`,
          migrations: ["0054_mcp_catalog_rename.sql"],
        },
        async () => undefined,
      ),
    ).rejects.toThrow("market_items holds rows whose kind is not mcp");
  });
});

describe("0055 MCP README columns", () => {
  test("every existing version starts pending and due, with the fetch state checked and indexed", async () => {
    await withIsolatedSchema(
      {
        prefix: "mcp_readme_columns",
        setupSql: `${await legacyCatalogSql()};\n${seed}`,
        migrations: ["0054_mcp_catalog_rename.sql", "0055_mcp_readme.sql"],
      },
      async (client) => {
        const versions = await client.query(
          `SELECT id, readme_md, readme_status, readme_attempts,
             readme_next_fetch_at = now() AS due_now, readme_path, readme_ref,
             readme_sha256, readme_etag, readme_fetched_at, readme_error
           FROM mcp_server_versions ORDER BY id`,
        );
        expect(versions.rows).toEqual([
          {
            id: "v-1",
            // Text a row already held is kept; the fetch replaces it.
            readme_md: "# Weather",
            readme_status: "pending",
            readme_attempts: 0,
            due_now: true,
            readme_path: null,
            readme_ref: null,
            readme_sha256: null,
            readme_etag: null,
            readme_fetched_at: null,
            readme_error: null,
          },
          {
            id: "v-2",
            readme_md: null,
            readme_status: "pending",
            readme_attempts: 0,
            due_now: true,
            readme_path: null,
            readme_ref: null,
            readme_sha256: null,
            readme_etag: null,
            readme_fetched_at: null,
            readme_error: null,
          },
        ]);

        // A version inserted later is pending and due by default too.
        await client.query(
          `INSERT INTO mcp_server_versions (id, server_id, version, status)
           VALUES ('v-3', 'mcp-weather', '1.2.0', 'published')`,
        );
        expect(
          (
            await client.query(
              "SELECT readme_status, readme_next_fetch_at IS NOT NULL AS due FROM mcp_server_versions WHERE id = 'v-3'",
            )
          ).rows[0],
        ).toEqual({ readme_status: "pending", due: true });

        await client.query("SAVEPOINT invalid_status");
        await expect(
          client.query(
            "UPDATE mcp_server_versions SET readme_status = 'fetched' WHERE id = 'v-1'",
          ),
        ).rejects.toThrow("mcp_server_versions_readme_status_check");
        await client.query("ROLLBACK TO SAVEPOINT invalid_status");

        const index = await client.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'mcp_server_versions_readme_due_idx'",
        );
        expect(index.rows[0]?.indexdef).toMatch(/\(readme_next_fetch_at\)$/);
      },
    );
  });
});
