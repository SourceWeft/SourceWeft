import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { describe, expect, test } from "vitest";
import { withIsolatedSchema } from "../../test/isolated-schema";

const drizzleFile = (name: string) =>
  readFile(
    new URL(`../../../../../packages/db/drizzle/${name}`, import.meta.url),
    "utf8",
  );

// drizzle qualifies foreign-key targets with "public"; point them at the
// throwaway schema so the tables below are the ones referenced.
async function migrate(client: Client, schema: string) {
  const sql = await drizzleFile("0079_agent_tasks.sql");
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
}

/** The two schedule tables exactly as the migration that created them left them. */
async function scheduleTablesBefore() {
  const statements = (await drizzleFile("0052_sparkling_madame_hydra.sql"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim());
  const pick = (start: string) => {
    const found = statements.filter((statement) => statement.startsWith(start));
    if (found.length !== 1) throw new Error(`Expected one statement: ${start}`);
    return `${found[0]!.replace(/;$/, "")};`;
  };
  return [
    pick('CREATE TABLE "task_schedules"'),
    pick('CREATE TABLE "schedule_occurrences"'),
    pick(
      'ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_schedule_id_task_schedules_id_fk"',
    ),
  ]
    .join("\n")
    .replaceAll('"public".', "");
}

// Only what the migration builds on, plus rows that exist before it runs.
const STUBS = `
  CREATE TABLE workspaces(
    id text primary key,
    organization_id text not null,
    unique (id, organization_id)
  );
  CREATE TABLE source_connectors(id text primary key);
  CREATE TABLE connector_sync_runs(id text primary key);
  CREATE TABLE chat_thread_runs(id text primary key);
  CREATE TABLE threads(
    id text primary key,
    origin text not null default 'user',
    CONSTRAINT threads_origin_check CHECK (origin in ('user', 'subagent'))
  );
`;

const EXISTING_ROWS = `
  INSERT INTO workspaces VALUES ('ws-a', 'team-a'), ('ws-b', 'team-b');
  INSERT INTO source_connectors VALUES ('conn-a'), ('conn-b');
  INSERT INTO threads(id, origin) VALUES ('thread-user', 'user'), ('thread-sub', 'subagent');
  INSERT INTO task_schedules(id, team_id, workspace_id, task_kind, owner_kind, connector_id, enabled, interval_minutes)
    VALUES ('sched-a', 'team-a', 'ws-a', 'connector_sync', 'workspace', 'conn-a', true, 60),
           ('sched-b', 'team-b', 'ws-b', 'connector_sync', 'workspace', 'conn-b', false, 1440);
  INSERT INTO schedule_occurrences(id, schedule_id, scheduled_for, status, attempts, last_error)
    VALUES ('occ-a1', 'sched-a', '2026-11-01T00:00:00Z', 'succeeded', 1, null),
           ('occ-a2', 'sched-a', '2026-11-01T01:00:00Z', 'skipped', 1, 'schedule_changed'),
           ('occ-a3', 'sched-a', '2026-11-01T02:00:00Z', 'pending', 0, null),
           ('occ-b1', 'sched-b', '2026-11-01T00:00:00Z', 'failed', 5, 'boom');
`;

async function migrated<T>(
  prefix: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const before = await scheduleTablesBefore();
  return withIsolatedSchema(
    { prefix, setupSql: `${STUBS}\n${before}\n${EXISTING_ROWS}` },
    async (client, schema) => {
      await migrate(client, schema);
      return fn(client);
    },
  );
}

/** Runs a statement that must fail without aborting the surrounding transaction. */
async function rejected(client: Client, sql: string, values: unknown[] = []) {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(sql, values);
    await client.query("RELEASE SAVEPOINT attempt");
    return null;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    return (
      (error as { constraint?: string; code?: string }).constraint ?? "error"
    );
  }
}

describe("0080_schedule_occurrence_tenant_not_null", () => {
  test("rows written without tenant keys are filled in, then the keys are required", async () => {
    await migrated("at_notnull", async (client) => {
      // What a scheduler from before 0079 could still write after it.
      await client.query(
        "INSERT INTO schedule_occurrences(id, schedule_id, scheduled_for) VALUES ('occ-old', 'sched-b', '2026-11-02T00:00:00Z')",
      );
      await client.query(
        await drizzleFile("0080_schedule_occurrence_tenant_not_null.sql"),
      );
      expect(
        (
          await client.query(
            "SELECT team_id, workspace_id FROM schedule_occurrences WHERE id = 'occ-old'",
          )
        ).rows,
      ).toEqual([{ team_id: "team-b", workspace_id: "ws-b" }]);
      expect(
        (
          await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schedule_occurrences' AND column_name IN ('team_id', 'workspace_id')",
          )
        ).rows,
      ).toEqual([{ is_nullable: "NO" }, { is_nullable: "NO" }]);
      expect(
        await rejected(
          client,
          "INSERT INTO schedule_occurrences(id, schedule_id, scheduled_for) VALUES ('occ-y', 'sched-a', now())",
        ),
      ).toBe("error");
      expect(
        await rejected(
          client,
          "INSERT INTO schedule_occurrences(id, schedule_id, team_id, workspace_id, scheduled_for) VALUES ('occ-z', 'sched-a', 'team-a', 'ws-a', now())",
        ),
      ).toBeNull();
    });
  });
});

describe("0079_agent_tasks", () => {
  test("existing occurrences inherit their schedule's team and workspace", async () => {
    await migrated("at_backfill", async (client) => {
      expect(
        (
          await client.query(
            "SELECT id, team_id, workspace_id, trigger_kind, skip_reason, chat_run_id, thread_id, task_version, is_catch_up, status FROM schedule_occurrences ORDER BY id",
          )
        ).rows,
      ).toEqual(
        [
          ["occ-a1", "team-a", "ws-a", "succeeded"],
          ["occ-a2", "team-a", "ws-a", "skipped"],
          ["occ-a3", "team-a", "ws-a", "pending"],
          ["occ-b1", "team-b", "ws-b", "failed"],
        ].map(([id, team_id, workspace_id, status]) => ({
          id,
          team_id,
          workspace_id,
          trigger_kind: "schedule",
          skip_reason: null,
          chat_run_id: null,
          thread_id: null,
          task_version: null,
          is_catch_up: false,
          status,
        })),
      );
      // A writer from before the migration can still insert its old shape.
      expect(
        await rejected(
          client,
          "INSERT INTO schedule_occurrences(id, schedule_id, scheduled_for) VALUES ('occ-x', 'sched-a', now())",
        ),
      ).toBeNull();
      expect(
        (
          await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schedule_occurrences' AND column_name IN ('team_id', 'workspace_id')",
          )
        ).rows,
      ).toEqual([{ is_nullable: "YES" }, { is_nullable: "YES" }]);
    });
  });

  test("existing connector schedules stay valid and keep working", async () => {
    await migrated("at_connector", async (client) => {
      expect(
        (
          await client.query(
            "SELECT id, agent_task_id FROM task_schedules ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "sched-a", agent_task_id: null },
        { id: "sched-b", agent_task_id: null },
      ]);
      await client.query(
        "UPDATE task_schedules SET interval_minutes = 120, enabled = true WHERE id = 'sched-b'",
      );
      await client.query(
        "INSERT INTO source_connectors VALUES ('conn-c'); INSERT INTO task_schedules(id, team_id, workspace_id, task_kind, owner_kind, connector_id, interval_minutes) VALUES ('sched-c', 'team-a', 'ws-a', 'connector_sync', 'workspace', 'conn-c', 30)",
      );
      await client.query(
        "INSERT INTO schedule_occurrences(id, schedule_id, team_id, workspace_id, scheduled_for) VALUES ('occ-c1', 'sched-c', 'team-a', 'ws-a', now())",
      );
      // The old statuses and the two new ones are all the table accepts.
      for (const status of ["dispatching", "queued", "blocked", "cancelled"])
        await client.query(
          "UPDATE schedule_occurrences SET status = $1 WHERE id = 'occ-c1'",
          [status],
        );
      expect(
        await rejected(
          client,
          "UPDATE schedule_occurrences SET status = 'running' WHERE id = 'occ-c1'",
        ),
      ).toBe("schedule_occurrences_status_check");
    });
  });

  test("existing threads keep their origin and may now be scheduled", async () => {
    await migrated("at_origin", async (client) => {
      await client.query(
        "INSERT INTO threads(id, origin) VALUES ('thread-sched', 'scheduled')",
      );
      expect(
        (await client.query("SELECT id, origin FROM threads ORDER BY id")).rows,
      ).toEqual([
        { id: "thread-sched", origin: "scheduled" },
        { id: "thread-sub", origin: "subagent" },
        { id: "thread-user", origin: "user" },
      ]);
      expect(
        await rejected(
          client,
          "INSERT INTO threads(id, origin) VALUES ('thread-x', 'cron')",
        ),
      ).toBe("threads_origin_check");
    });
  });
});
