import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let threads: typeof import("../../thread/repository");
let messagesRepo: typeof import("../../message-repository");
let projection: typeof import("./subagent-projection");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("subagent_proj");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  threads = await import("../../thread/repository");
  messagesRepo = await import("../../message-repository");
  projection = await import("./subagent-projection");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Sub-agent projection",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.workspaceMemberships)
    .values([{ workspaceId, userId: owner, role: "editor", source: "guest" }]);
});

afterEach(async () => {
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function createParent(visibility: "private" | "workspace") {
  return threads.createThreadRecord({
    teamId,
    workspaceId,
    title: "Multi agent proofs",
    createdBy: owner,
    visibility,
  });
}

test("a delegate's child thread nests under the parent with the matching persona", async () => {
  const parent = await createParent("workspace");
  const child = await projection.createChildThreadForDelegate({
    parent,
    userId: owner,
    subagentType: "explore",
    brief: "Verify 1+1=2 with Peano arithmetic. Show every step.",
  });
  assert.equal(child.title, "Verify 1+1=2 with Peano arithmetic.");
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.personaId, "explore");
  assert.equal(child.origin, "subagent");
  assert.equal(child.visibility, "workspace");
  assert.equal(child.createdBy, owner);

  // A private parent keeps its child private; an unknown delegate type still
  // gets a thread, just without a persona.
  const privateParent = await createParent("private");
  const orphan = await projection.createChildThreadForDelegate({
    parent: privateParent,
    userId: owner,
    subagentType: "not-a-builtin",
    brief: "",
  });
  assert.equal(orphan.visibility, "private");
  assert.equal(orphan.personaId, null);
  assert.equal(orphan.title, "not-a-builtin");

  // A persona thread's own delegate attaches to the top-level parent.
  const grandchild = await projection.createChildThreadForDelegate({
    parent: child,
    userId: owner,
    subagentType: "plan",
    brief: "Plan it.",
  });
  assert.equal(grandchild.parentThreadId, parent.id);
});

test("the transcript is persisted as the child thread's messages with the seeded checkpoint", async () => {
  const parent = await createParent("workspace");
  const child = await projection.createChildThreadForDelegate({
    parent,
    userId: owner,
    subagentType: "explore",
    brief: "echo something back.",
  });
  const seeded = {
    threadId: child.id,
    checkpointId: "checkpoint_1",
    checkpointNs: "",
  };
  let seededMessageCount = 0;
  const result = await projection.persistSubagentTranscript({
    scope: { teamId, workspaceId },
    childThreadId: child.id,
    parentThreadId: parent.id,
    taskCallId: "task-1",
    subagentType: "explore",
    brief: "echo something back.",
    report: "done",
    entries: [
      {
        kind: "ai",
        text: "",
        toolCalls: [{ id: "echo-1", name: "echo", args: { text: "hi" } }],
      },
      {
        kind: "tool",
        id: "echo-1",
        name: "echo",
        content: "echoed: hi",
        status: "completed",
      },
      { kind: "ai", text: "done", toolCalls: [] },
    ],
    toolTraces: new Map([
      [
        "echo-1",
        {
          id: "echo-1",
          tool: "echo",
          input: { text: "hi" },
          output: { content: "echoed: hi" },
          status: "completed",
          latencyMs: 7,
          error: null,
          sequence: 4,
        },
      ],
    ]),
    modelAlias: "chat-default",
    createdBy: owner,
    seedCheckpoint: async ({ messages }) => {
      seededMessageCount = messages.length;
      return seeded;
    },
  });
  assert.equal(result.assistantRows, 2);
  assert.deepEqual(result.checkpoint, seeded);
  assert.equal(seededMessageCount, 4);

  const rows = await messagesRepo.listMessageRecordsByThread({
    teamId,
    workspaceId,
    threadId: child.id,
  });
  assert.deepEqual(
    rows.map((row) => [row.role, row.content]),
    [
      ["user", "echo something back."],
      ["assistant", ""],
      ["assistant", "done"],
    ],
  );
  const [user, first, last] = rows;
  assert.equal(user?.metadata.source, "subagent_projection");
  assert.deepEqual(user?.metadata.subagent, {
    parentThreadId: parent.id,
    taskCallId: "task-1",
    subagentType: "explore",
  });
  const toolCalls = first?.metadata.toolCalls as Array<{
    id: string;
    latencyMs: number | null;
  }>;
  assert.equal(toolCalls?.[0]?.id, "echo-1");
  // The runner's own trace wins over a synthesized one.
  assert.equal(toolCalls?.[0]?.latencyMs, 7);
  assert.deepEqual(first?.metadata.renderBlocks, [
    { id: "tool-echo-1", type: "tool", toolCallId: "echo-1" },
  ]);
  assert.equal(first?.metadata.agentCheckpoint, undefined);
  assert.deepEqual(last?.metadata.renderBlocks, [
    { id: "text-1", type: "text", text: "done" },
  ]);
  assert.deepEqual(
    (last?.metadata.agentCheckpoint as { final: unknown }).final,
    seeded,
  );

  const refreshed = await threads.findThreadRecord({
    threadId: child.id,
    teamId,
    workspaceId,
  });
  assert.ok(refreshed?.lastMessageAt, "appending messages bumps activity");
});

test("a missing report and a checkpoint failure still leave a readable thread", async () => {
  const parent = await createParent("workspace");
  const child = await projection.createChildThreadForDelegate({
    parent,
    userId: owner,
    subagentType: "plan",
    brief: "Plan it.",
  });
  const result = await projection.persistSubagentTranscript({
    scope: { teamId, workspaceId },
    childThreadId: child.id,
    parentThreadId: parent.id,
    taskCallId: "task-2",
    subagentType: "plan",
    brief: "Plan it.",
    report: "the plan",
    entries: [],
    toolTraces: new Map(),
    modelAlias: null,
    createdBy: owner,
    seedCheckpoint: async () => {
      throw new Error("checkpointer down");
    },
  });
  assert.equal(result.checkpoint, null);
  const rows = await messagesRepo.listMessageRecordsByThread({
    teamId,
    workspaceId,
    threadId: child.id,
  });
  assert.deepEqual(
    rows.map((row) => [row.role, row.content]),
    [
      ["user", "Plan it."],
      ["assistant", "the plan"],
    ],
  );
  assert.deepEqual(
    (rows[1]?.metadata.agentCheckpoint as { final: unknown }).final,
    null,
  );
});

test("a paused task's brief lets a resumed run find its child thread by call id", async () => {
  const parent = await createParent("workspace");
  const child = await projection.createChildThreadForDelegate({
    parent,
    userId: owner,
    subagentType: "general-purpose",
    brief: "Send the weekly email.",
  });
  const lookup = {
    teamId,
    workspaceId,
    parentThreadId: parent.id,
    taskCallId: "task-1",
  };
  assert.equal(await threads.findSubagentThreadRecordByTaskCall(lookup), null);

  await projection.persistSubagentBrief({
    scope: { teamId, workspaceId },
    childThreadId: child.id,
    parentThreadId: parent.id,
    taskCallId: "task-1",
    subagentType: "general-purpose",
    brief: "Send the weekly email.",
    createdBy: owner,
  });
  assert.equal(
    (await threads.findSubagentThreadRecordByTaskCall(lookup))?.id,
    child.id,
  );
  assert.equal(
    await threads.findSubagentThreadRecordByTaskCall({
      ...lookup,
      taskCallId: "task-2",
    }),
    null,
  );

  // The resumed run's transcript follows the brief without repeating it.
  await projection.persistSubagentTranscript({
    scope: { teamId, workspaceId },
    childThreadId: child.id,
    parentThreadId: parent.id,
    taskCallId: "task-1",
    subagentType: "general-purpose",
    brief: "Send the weekly email.",
    briefPersisted: true,
    report: "sent",
    entries: [{ kind: "ai", text: "sent", toolCalls: [] }],
    toolTraces: new Map(),
    modelAlias: null,
    createdBy: owner,
    seedCheckpoint: async () => null,
  });
  const rows = await messagesRepo.listMessageRecordsByThread({
    teamId,
    workspaceId,
    threadId: child.id,
  });
  assert.deepEqual(
    rows.map((row) => [row.role, row.content]),
    [
      ["user", "Send the weekly email."],
      ["assistant", "sent"],
    ],
  );
});
