import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { describe, expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

// drizzle qualifies foreign-key targets with "public"; point them at the
// throwaway schema so the stub tables below are the ones referenced.
async function migrate(client: Client, schema: string) {
  const sql = await readFile(
    new URL(
      "../../../../../packages/db/drizzle/0069_local_network_approvals.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
}

// Transaction-scoped isolated schema: only the tables the migration builds on.
const BASE = `
  CREATE TABLE threads(id text primary key);
  CREATE TABLE local_devices(id text primary key, user_id text);
  CREATE TABLE local_tool_invocations(id text primary key);
  INSERT INTO local_devices VALUES ('pc', 'owner'), ('other-pc', 'owner');
  INSERT INTO threads VALUES ('t');
  INSERT INTO local_tool_invocations VALUES ('inv');
`;

const RESOLVED = "2030-01-01T00:00:00Z";

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
    host: "example.com",
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

describe("0069_local_network_approvals", () => {
  test("devices default to ask and only accept the three modes", async () => {
    await withIsolatedSchema(
      {
        prefix: "net_mode",
        setupSql: BASE,
      },
      async (client, schema) => {
        await migrate(client, schema);
        expect(
          (await client.query("SELECT network_mode FROM local_devices")).rows,
        ).toEqual([{ network_mode: "ask" }, { network_mode: "ask" }]);
        for (const mode of ["open", "ask", "strict"])
          await client.query("UPDATE local_devices SET network_mode=$1", [
            mode,
          ]);
        await client.query("SAVEPOINT invalid");
        await expect(
          client.query("UPDATE local_devices SET network_mode='any'"),
        ).rejects.toThrow("local_devices_network_mode_check");
        await client.query("ROLLBACK TO SAVEPOINT invalid");
      },
    );
  });

  test("requests enforce status, scope, port, resolution and idempotency", async () => {
    await withIsolatedSchema(
      {
        prefix: "net_req",
        setupSql: BASE,
      },
      async (client, schema) => {
        await migrate(client, schema);
        await client.query(...insert());
        expect(
          (
            await client.query(
              "SELECT status, scope, resolved_at, delivered_at FROM local_network_requests",
            )
          ).rows,
        ).toEqual([
          {
            status: "pending",
            scope: null,
            resolved_at: null,
            delivered_at: null,
          },
        ]);
        const rejected = async (
          sql: string,
          params: unknown[],
          constraint: string,
        ) => {
          await client.query("SAVEPOINT invalid");
          await expect(client.query(sql, params)).rejects.toThrow(constraint);
          await client.query("ROLLBACK TO SAVEPOINT invalid");
        };
        // The same ask re-sent by one device is one row; another device's is not.
        await rejected(
          ...insert({ id: "r2" }),
          "local_network_requests_device_ask_uq",
        );
        await client.query(...insert({ id: "r2", device_id: "other-pc" }));
        await rejected(
          ...insert({
            id: "r3",
            ask_id: "a3",
            status: "maybe",
            resolved_at: RESOLVED,
          }),
          "local_network_requests_status_check",
        );
        for (const port of [0, 65536])
          await rejected(
            ...insert({ id: "r4", ask_id: "a4", port }),
            "local_network_requests_port_check",
          );
        await rejected(
          ...insert({ id: "r5", ask_id: "a5", scope: "once" }),
          "local_network_requests_scope_check",
        );
        await rejected(
          ...insert({
            id: "r6",
            ask_id: "a6",
            status: "allowed",
            scope: "forever",
            resolved_at: RESOLVED,
          }),
          "local_network_requests_scope_check",
        );
        // A pending row has no resolution time; a settled one must have it.
        await rejected(
          ...insert({
            id: "r7",
            ask_id: "a7",
            resolved_at: "2030-01-01T00:00:00Z",
          }),
          "local_network_requests_resolved_check",
        );
        await rejected(
          ...insert({ id: "r8", ask_id: "a8", status: "denied" }),
          "local_network_requests_resolved_check",
        );
        await client.query(
          ...insert({
            id: "r9",
            ask_id: "a9",
            status: "allowed",
            scope: "always",
            resolved_at: "2030-01-01T00:00:00Z",
          }),
        );
        // Referential integrity: no ask for an unknown invocation, device or thread.
        for (const [column, constraint] of [
          ["invocation_id", "local_network_requests_invocation_id"],
          ["device_id", "local_network_requests_device_id"],
          ["thread_id", "local_network_requests_thread_id"],
        ] as const)
          await rejected(
            ...insert({ id: "r10", ask_id: "a10", [column]: "missing" }),
            constraint,
          );
      },
    );
  });

  test("requests disappear with their invocation or thread", async () => {
    await withIsolatedSchema(
      {
        prefix: "net_cascade",
        setupSql: BASE,
      },
      async (client, schema) => {
        await migrate(client, schema);
        await client.query(...insert());
        await client.query("DELETE FROM local_tool_invocations WHERE id='inv'");
        expect(
          (await client.query("SELECT 1 FROM local_network_requests")).rowCount,
        ).toBe(0);
        await client.query(
          "INSERT INTO local_tool_invocations VALUES ('inv2')",
        );
        await client.query(...insert({ id: "r2", invocation_id: "inv2" }));
        await client.query("DELETE FROM threads WHERE id='t'");
        expect(
          (await client.query("SELECT 1 FROM local_network_requests")).rowCount,
        ).toBe(0);
      },
    );
  });
});
