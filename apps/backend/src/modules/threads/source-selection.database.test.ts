import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
}));
vi.mock("@sourceweft/db", () => ({ database: { query: state.query } }));
vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async ({
    workspaceId,
  }: {
    workspaceId: string;
  }) => ({ id: workspaceId, organizationId: "team" }),
}));
vi.mock("../workspace/content-visibility", () => ({
  canViewThread: (user: string) => user === "owner",
}));
vi.mock("./thread/repository", () => ({
  findThreadRecord: async () => ({ id: "conversation" }),
}));
vi.mock("../sources/service", () => ({
  resolveSourceTreeScope: async ({
    selectedSourceIds,
  }: {
    selectedSourceIds: string[];
  }) => ({
    effectiveSourceIds: selectedSourceIds.filter((id) => id === "allowed"),
  }),
}));

import {
  getThreadSourceSelection,
  updateThreadSourceSelection,
} from "./source-selection-service";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
const scope = {
  workspaceId: "workspace",
  threadId: "conversation",
  userId: "owner",
};
beforeAll(async () => {
  await client.connect();
  await client.query("BEGIN");
  const schema = `source_selection_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    "CREATE TABLE threads (id text primary key, team_id text, workspace_id text)",
  );
  await client.query(
    "INSERT INTO threads VALUES ('conversation','team','workspace')",
  );
  await client.query(
    await readFile(
      new URL(
        "../../../../../packages/db/drizzle/0035_thread_source_selection.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await client.query(
    "INSERT INTO threads(id,team_id,workspace_id) VALUES ('new','team','workspace')",
  );
  state.query.mockImplementation((sql, params) => client.query(sql, params));
});
afterAll(async () => {
  await client.query("ROLLBACK");
  await client.end();
});

it("every conversation starts with an empty selection without history initialization", async () => {
  const rows = (await client.query("SELECT source_selection_json FROM threads"))
    .rows;
  for (const row of rows)
    expect(row.source_selection_json).toEqual({
      revision: 0,
      selectedSourceIds: [],
    });
});

it("persists an explicit selection and clearing", async () => {
  const first = await updateThreadSourceSelection({
    ...scope,
    expectedRevision: 0,
    selectedSourceIds: ["allowed"],
  });
  expect(first.selection).toEqual({
    revision: 1,
    selectedSourceIds: ["allowed"],
  });
  const cleared = await updateThreadSourceSelection({
    ...scope,
    expectedRevision: 1,
    selectedSourceIds: [],
  });
  expect(cleared.selection).toEqual({ revision: 2, selectedSourceIds: [] });
  expect((await getThreadSourceSelection(scope)).selection).toEqual(
    cleared.selection,
  );
});

it("rejects a stale compare-and-swap instead of overwriting a newer window", async () => {
  await expect(
    updateThreadSourceSelection({
      ...scope,
      expectedRevision: 1,
      selectedSourceIds: ["allowed"],
    }),
  ).rejects.toMatchObject({ code: "SOURCE_SELECTION_CONFLICT" });
  expect(
    (await getThreadSourceSelection(scope)).selection.selectedSourceIds,
  ).toEqual([]);
});

it("rejects foreign sources, foreign workspaces and invisible threads", async () => {
  await expect(
    updateThreadSourceSelection({
      ...scope,
      expectedRevision: 2,
      selectedSourceIds: ["forbidden"],
    }),
  ).rejects.toMatchObject({ code: "SOURCE_ACCESS_DENIED" });
  await expect(
    getThreadSourceSelection({ ...scope, workspaceId: "foreign" }),
  ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  await expect(
    getThreadSourceSelection({ ...scope, userId: "other" }),
  ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
});
