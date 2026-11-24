import assert from "node:assert/strict";
import { Client } from "pg";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

// `auth migrate` (run by `db:migrate`, which builds this suite's template
// database — see global-setup.ts) must create the `ssoProvider` table with
// the columns the plugin and the later guard/provisioning tasks rely on.

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let client: Client;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("sso_schema");
  client = new Client({ connectionString: isolated.url });
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.end();
  await isolated?.close();
});

test("the ssoProvider table exists with the expected columns", async () => {
  const result = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = $1`,
    ["ssoProvider"],
  );
  const columns = new Set(result.rows.map((row) => row.column_name));

  for (const column of [
    "providerId",
    "organizationId",
    "domain",
    "domainVerified",
    "oidcConfig",
    "samlConfig",
    "roleAttribute",
    "adminRoleValue",
  ]) {
    assert.ok(columns.has(column), `expected ssoProvider.${column} to exist`);
  }
});
