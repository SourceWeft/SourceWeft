import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { describe, expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

const BASE = `
  CREATE TABLE threads(id text primary key);
  CREATE TABLE local_devices(id text primary key, user_id text);
  CREATE TABLE local_tool_invocations(id text primary key);
  INSERT INTO local_devices VALUES ('pc', 'owner');
  INSERT INTO threads VALUES ('t');
  INSERT INTO local_tool_invocations VALUES ('inv');
`;

// drizzle qualifies foreign-key targets with "public"; point them at the
// throwaway schema so the stub tables above are the ones referenced.
async function migrate(client: Client, schema: string) {
  for (const file of [
    "0064_local_network_approvals.sql",
    "0065_local_network_request_kind.sql",
  ]) {
    const sql = await readFile(
      new URL(`../../../../../packages/db/drizzle/${file}`, import.meta.url),
      "utf8",
    );
    await client.query(sql.replaceAll('"public".', `"${schema}".`));
  }
}

const insert = (
  overrides: Record<string, string | number | null> = {},
): [string, unknown[]] => {
  const row: Record<string, string | number | null> = {
    id: "r1",
    invocation_id: "inv",
    device_id: "pc",
    user_id: "owner",
    team_id: "team",
    workspace_id: "ws",
    thread_id: "t",
    ask_id: "ask-1",
    host: "api.example.com",
    port: 443,
    expires_at: "2030-01-01T00:00:00Z",
    ...overrides,
  };
  const keys = Object.keys(row);
  return [
    `INSERT INTO local_network_requests(${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    keys.map((key) => row[key]),
  ];
};

describe("0065_local_network_request_kind", () => {
  test("existing rows become host asks; request rows must carry a method", async () => {
    await withIsolatedSchema(
      { prefix: "net_kind", setupSql: BASE },
      async (client, schema) => {
        // A row written before the migration.
        await client.query(
          (
            await readFile(
              new URL(
                "../../../../../packages/db/drizzle/0064_local_network_approvals.sql",
                import.meta.url,
              ),
              "utf8",
            )
          ).replaceAll('"public".', `"${schema}".`),
        );
        await client.query(...insert({ id: "old", ask_id: "old" }));
        await client.query(
          (
            await readFile(
              new URL(
                "../../../../../packages/db/drizzle/0065_local_network_request_kind.sql",
                import.meta.url,
              ),
              "utf8",
            )
          ).replaceAll('"public".', `"${schema}".`),
        );
        expect(
          (
            await client.query(
              "SELECT kind, method, path FROM local_network_requests",
            )
          ).rows,
        ).toEqual([{ kind: "host", method: null, path: null }]);
      },
    );
  });

  test("the kind decides which columns may be set", async () => {
    await withIsolatedSchema(
      { prefix: "net_kind2", setupSql: BASE },
      async (client, schema) => {
        await migrate(client, schema);
        const rejected = async (
          args: [string, unknown[]],
          constraint: string,
        ) => {
          await client.query("SAVEPOINT invalid");
          await expect(client.query(...args)).rejects.toThrow(constraint);
          await client.query("ROLLBACK TO SAVEPOINT invalid");
        };
        await client.query(
          ...insert({
            id: "w",
            ask_id: "w",
            kind: "request",
            method: "POST",
            path: "/v1/items",
          }),
        );
        // A request without a method, a host with one, and an unknown kind.
        await rejected(
          insert({ id: "a", ask_id: "a", kind: "request" }),
          "local_network_requests_request_shape_check",
        );
        await rejected(
          insert({ id: "b", ask_id: "b", method: "GET" }),
          "local_network_requests_request_shape_check",
        );
        await rejected(
          insert({ id: "c", ask_id: "c", path: "/x" }),
          "local_network_requests_request_shape_check",
        );
        await rejected(
          insert({ id: "d", ask_id: "d", kind: "rule", method: "GET" }),
          "local_network_requests_kind_check",
        );
        await rejected(
          insert({
            id: "e",
            ask_id: "e",
            kind: "request",
            method: "P".repeat(17),
          }),
          "local_network_requests_request_shape_check",
        );
        await rejected(
          insert({
            id: "f",
            ask_id: "f",
            kind: "request",
            method: "PUT",
            path: `/${"x".repeat(200)}`,
          }),
          "local_network_requests_request_shape_check",
        );
        // The dedupe key is unchanged: one row per (device, ask).
        await rejected(
          insert({
            id: "g",
            ask_id: "w",
            kind: "request",
            method: "POST",
            path: "/other",
          }),
          "local_network_requests_device_ask_uq",
        );
      },
    );
  });
});
