import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { beginReasoningRun, projectReasoning } from "./turn/reasoning-state";
import { appendAgentRunOrigin } from "./turn/agent-run-origins";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./message-repository");
const originalUrl = process.env.DATABASE_URL;
const teamId = randomUUID(),
  workspaceId = randomUUID(),
  threadId = randomUUID();
let messageId: string;
const scope = () => ({ teamId, workspaceId, threadId, messageId });
const current = () => repository.findMessageRecord(scope());

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("msg_projection");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./message-repository");
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Projection",
    slug: workspaceId,
  });
  await schema.db
    .insert(schema.threads)
    .values({ id: threadId, teamId, workspaceId, title: "Projection" });
}, 120_000);
beforeEach(async () => {
  messageId = randomUUID();
  await schema.db.insert(schema.messages).values({
    id: messageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "prefix",
    creditsConsumed: 17,
    metadata: { marker: "latest", counter: 0 },
  });
});
afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

test("locked projections preserve concurrent latest metadata and return no unused large record", async () => {
  const large = "large-metadata-" + "x".repeat(5 * 1024 * 1024);
  await repository.updateMessageRecord({
    ...scope(),
    metadata: { marker: "latest", counter: 0, large },
  });
  const project = (
    message: NonNullable<Awaited<ReturnType<typeof current>>>,
  ) => ({
    content: message.content + " next",
    metadata: {
      ...message.metadata,
      counter: Number(message.metadata.counter) + 1,
    },
  });
  const result = await Promise.all([
    repository.persistMessageProjection({ ...scope(), project }),
    repository.persistMessageProjection({ ...scope(), project }),
  ]);
  assert.deepEqual(result, [undefined, undefined]);
  const message = (await current())!;
  assert.equal(message.metadata.counter, 2);
  assert.equal(message.metadata.large, large);
  assert.equal(message.content, "prefix next next");
  assert.equal(message.creditsConsumed, 17);
});

test("projection scope is checked before callback and callback failures roll back", async () => {
  let calls = 0;
  for (const denied of [
    { ...scope(), teamId: randomUUID() },
    { ...scope(), workspaceId: randomUUID() },
    { ...scope(), threadId: randomUUID() },
    { ...scope(), messageId: randomUUID() },
  ]) {
    await repository.persistMessageProjection({
      ...denied,
      project: () => {
        calls++;
        return { metadata: {}, content: "denied" };
      },
    });
  }
  assert.equal(calls, 0);
  await assert.rejects(
    repository.persistMessageProjection({
      ...scope(),
      project: () => {
        throw new Error("projection failed");
      },
    }),
    /projection failed/,
  );
  assert.equal((await current())?.content, "prefix");
});

test("projection reuses reasoning ownership, stale revision and terminal guards for the entire write", async () => {
  const run = beginReasoningRun({ runId: "owner", continuation: false });
  const latest = projectReasoning({
    run,
    text: "complete",
    revision: 10,
    terminal: true,
  });
  await repository.updateMessageRecord({
    ...scope(),
    content: "settled",
    metadata: latest,
  });
  for (const metadata of [
    projectReasoning({ run, text: "stale", revision: 1 }),
    projectReasoning({
      run: beginReasoningRun({ runId: "other", continuation: false }),
      text: "other",
    }),
  ]) {
    await repository.persistMessageProjection({
      ...scope(),
      project: () => ({ content: "must not overwrite", metadata }),
    });
    assert.equal((await current())?.content, "settled");
    assert.deepEqual((await current())?.metadata, latest);
  }
  await repository.persistMessageProjection({
    ...scope(),
    project: (message) => ({
      metadata: { ...message.metadata, marker: "preserved" },
    }),
  });
  assert.equal((await current())?.metadata.reasoning, "complete");
});

test("projection retains authoritative committed artifact/tool output and existing accounting", async () => {
  const block = {
    id: "artifact-output:run:artifact:version",
    type: "artifact_output",
    artifactId: "artifact",
    artifactVersionId: "version",
    threadRunId: "run",
    sourceToolCallId: "publisher",
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
  };
  const call = {
    id: "publisher",
    tool: "publish_artifact",
    input: {},
    status: "completed",
    latencyMs: 1,
    error: null,
    sequence: 1,
    producer: { kind: "main" },
    output: {
      status: "ready",
      type: "committed_artifact_result",
      artifactType: "html",
      artifactId: "artifact",
      artifactVersionId: "version",
      artifactOutputBlockId: block.id,
      workflowVersion: "file-publish",
    },
  };
  await repository.updateMessageRecord({
    ...scope(),
    metadata: {
      renderBlocks: [block],
      toolCalls: [call],
      meteredLlmCreditsConsumed: 17,
    },
  });
  await repository.persistMessageProjection({
    ...scope(),
    project: (message) => ({
      content: "streamed",
      metadata: {
        ...message.metadata,
        renderBlocks: [],
        toolCalls: [{ ...call, status: "running", output: null }],
      },
    }),
  });
  const message = (await current())!;
  assert.deepEqual(message.metadata.renderBlocks, [block]);
  const actual = (message.metadata.toolCalls as (typeof call)[])[0]!;
  assert.equal(actual.status, "completed");
  assert.deepEqual(actual.output, call.output);
  assert.equal(message.metadata.meteredLlmCreditsConsumed, 17);
  assert.equal(message.creditsConsumed, 17);
  // Existing callers still receive complete records from the original API.
  assert.equal(
    (
      await repository.updateMessageRecord({
        ...scope(),
        content: "full result",
      })
    )?.content,
    "full result",
  );
});

test("concurrent host graph lineage appends preserve both references and locked metadata", async () => {
  await schema.db
    .update(schema.messages)
    .set({ role: "user" })
    .where((await import("drizzle-orm")).eq(schema.messages.id, messageId));
  const append = (graphThreadId: string) =>
    repository.persistMessageProjection({
      ...scope(),
      project: (current) => ({
        metadata: appendAgentRunOrigin({
          current,
          teamId,
          workspaceId,
          threadId,
          userMessageId: messageId,
          graphThreadId,
        }),
      }),
    });
  await Promise.all([append("first-graph"), append("second-graph")]);
  const row = (await current())!;
  assert.deepEqual([...(row.metadata.agentRunThreadIds as string[])].sort(), [
    "first-graph",
    "second-graph",
  ]);
  assert.equal(row.metadata.marker, "latest");
  assert.equal(row.metadata.counter, 0);
  await append("first-graph");
  assert.equal(
    ((await current())!.metadata.agentRunThreadIds as string[]).length,
    2,
  );
});

test("the /messages client view projects a stored legacy row without rewriting it", async () => {
  const { projectThreadMessageForClient } =
    await import("./message-client-view");
  const excerpt = "Invoice total is 50.";
  const legacy = {
    reasoning: "Need to search.",
    meteredLlmCalls: [{ spanId: "span-1", consumedCredits: 17 }],
    reasoningSegments: [
      { id: "segment-1", text: "Need to search.", sequence: 1 },
    ],
    traceEvents: [
      {
        type: "tool-call",
        id: "tool-call:search-1:2",
        itemId: "search-1",
        payload: {
          toolCall: {
            id: "search-1",
            tool: "notion_search",
            mcpDisplay: { serverName: "Notion", toolName: "search" },
          },
        },
      },
    ],
    toolCalls: [
      {
        id: "search-1",
        tool: "notion_search",
        input: { query: "invoice" },
        output: { pages: 1 },
        status: "completed",
        sequence: 2,
      },
    ],
    traceParts: [
      { id: "segment-1", kind: "reasoning", order: 0, text: "Need to search." },
      {
        id: "search-1",
        kind: "tool",
        order: 1,
        toolCallId: "search-1",
        tool: "notion_search",
        status: "completed",
        input: { query: "invoice" },
      },
    ],
    retrieval: {
      citations: [{ citation: "c1", excerpt, quoteText: excerpt }],
      availableCitations: [{ citation: "c1", excerpt, quoteText: excerpt }],
    },
  };
  await repository.updateMessageRecord({ ...scope(), metadata: legacy });

  const [stored] = await repository
    .listMessageRecordsByThread({
      teamId,
      workspaceId,
      threadId,
    })
    .then((items) => items.filter((item) => item.id === messageId));
  assert.ok(stored);
  const view = projectThreadMessageForClient(stored).metadata;
  const body = JSON.stringify(view);
  for (const absent of [
    '"meteredLlmCalls"',
    '"reasoning":',
    '"traceEvents"',
    '"quoteText"',
    '"text"',
  ]) {
    assert.equal(body.includes(absent), false, absent);
  }
  assert.equal(
    (view.traceParts as Record<string, unknown>[]).some((part) =>
      Object.hasOwn(part, "input"),
    ),
    false,
  );
  assert.deepEqual(
    (view.toolCalls as Record<string, unknown>[])[0]?.mcpDisplay,
    {
      serverName: "Notion",
      toolName: "search",
    },
  );
  // Storage is unchanged: the projection is read-time only.
  const row = (await current())!;
  assert.equal(row.metadata.reasoning, "Need to search.");
  assert.deepEqual(row.metadata.meteredLlmCalls, legacy.meteredLlmCalls);
  assert.deepEqual(row.metadata.traceParts, legacy.traceParts);
  assert.deepEqual(row.metadata.retrieval, legacy.retrieval);
});
