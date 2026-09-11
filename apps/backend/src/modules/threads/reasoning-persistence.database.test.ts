import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@sourceweft/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@sourceweft/db", async () => ({
  ...(await import("@sourceweft/db/schema")),
  get db() {
    return state.db;
  },
}));

import {
  updateMessageRecord,
  updateMessageMetadataRecord,
} from "./message-repository";
import { beginReasoningRun, projectReasoning } from "./turn/reasoning-state";

const schemaName = `reasoning_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schemaName}`,
  connectionTimeoutMillis: 5000,
  max: 3,
});
const scope = {
  teamId: "team",
  workspaceId: "workspace",
  threadId: "thread",
  messageId: "assistant",
};
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  // Copy schema only. No real conversation data is read or changed.
  await admin.query(
    `CREATE TABLE "${schemaName}".messages (LIKE public.messages INCLUDING DEFAULTS)`,
  );
  await pool.query(
    "INSERT INTO messages(id,team_id,workspace_id,thread_id,role,content) VALUES ('assistant','team','workspace','thread','assistant','answer')",
  );
  state.db = drizzle(pool, { schema, casing: "snake_case" });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await admin.end();
});

it("persists resume snapshots once and rejects concurrent stale writers under the row lock", async () => {
  const first = projectReasoning({
    run: beginReasoningRun({ runId: "first", continuation: false }),
    text: "before approval",
    terminal: true,
  });
  await updateMessageRecord({ ...scope, metadata: first });
  const run = beginReasoningRun({
    runId: "resume",
    continuation: true,
    metadata: first,
  });
  for (let revision = 1; revision <= 30; revision++) {
    await updateMessageRecord({
      ...scope,
      metadata: projectReasoning({ run, text: "x".repeat(revision), revision }),
    });
  }
  const latest = projectReasoning({
    run,
    text: "complete reasoning",
    revision: 100,
  });
  await Promise.all([
    updateMessageRecord({ ...scope, content: "new answer", metadata: latest }),
    updateMessageRecord({
      ...scope,
      content: "stale answer",
      metadata: projectReasoning({ run, text: "old partial", revision: 2 }),
    }),
  ]);
  let row = (
    await pool.query(
      "SELECT content,metadata FROM messages WHERE id='assistant'",
    )
  ).rows[0];
  expect(row.content).toBe("new answer");
  expect(row.metadata.reasoning).toBe("before approval\ncomplete reasoning");

  const terminal = projectReasoning({
    run,
    text: "complete reasoning",
    terminal: true,
  });
  await updateMessageRecord({
    ...scope,
    metadata: {
      ...terminal,
      finishReason: "tool_confirmation_requested",
      credits: 12,
    },
  });
  // This is the approval metadata-only writer, not the progress writer.
  await updateMessageMetadataRecord({
    ...scope,
    metadata: { ...terminal, approved: true },
  });
  await updateMessageRecord({ ...scope, metadata: latest });
  row = (await pool.query("SELECT metadata FROM messages WHERE id='assistant'"))
    .rows[0];
  expect(row.metadata.approved).toBe(true);
  expect(row.metadata.reasoningWrite.terminal).toBe(true);

  const nextRun = beginReasoningRun({
    runId: "next",
    continuation: true,
    metadata: row.metadata,
  });
  const next = projectReasoning({
    run: nextRun,
    text: "after approval",
    revision: 1,
  });
  await updateMessageRecord({
    ...scope,
    content: "next answer",
    metadata: next,
  });
  await updateMessageRecord({
    ...scope,
    content: "late old answer",
    metadata: terminal,
  });
  row = (
    await pool.query(
      "SELECT content,metadata FROM messages WHERE id='assistant'",
    )
  ).rows[0];
  expect(row.content).toBe("next answer");
  expect(row.metadata.reasoning).toBe(
    "before approval\ncomplete reasoning\nafter approval",
  );
  const retry = beginReasoningRun({
    runId: "next",
    continuation: true,
    metadata: row.metadata,
  });
  expect(retry).toEqual(nextRun);
  await updateMessageMetadataRecord({
    ...scope,
    metadata: { unrelatedStatus: "updated" },
  });
  row = (await pool.query("SELECT metadata FROM messages WHERE id='assistant'"))
    .rows[0];
  expect(row.metadata.reasoning).toBe(next.reasoning);
  expect(row.metadata.reasoningWrite.runId).toBe("next");
});
