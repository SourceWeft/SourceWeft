import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  artifactVersions,
  artifacts,
  chatThreadRuns,
  db,
  messages,
  threads,
  workspaceMemberships,
  workspaces,
} from "@sourceweft/db";
import {
  requestChatThreadRunCancel,
  updateChatThreadRunProgress,
} from "../threads/durable/repository";
import { updateMessageMetadataRecord } from "../threads/message-repository";
import { createReadyArtifactRecord } from "./repository";
import {
  createCurrentRunArtifactPublicationService,
  type CurrentRunArtifactPublicationInput,
  type CurrentRunArtifactPublicationStage,
} from "./current-run-publication";

let teamId: string;
let workspaceId: string;
let threadId: string;
let creatorUserId: string;
let editorUserId: string;

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  threadId = randomUUID();
  creatorUserId = randomUUID();
  editorUserId = randomUUID();

  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Current-run artifact publication test",
    slug: `current-run-publication-${workspaceId}`,
  });
  await db.execute(sql`
    insert into organization (id, name, slug, "createdAt")
    values (
      ${teamId},
      'Current-run artifact publication test',
      ${`current-run-publication-${teamId}`},
      now()
    )
  `);
  await db.execute(sql`
    insert into "user" (
      id,
      name,
      email,
      "emailVerified",
      "createdAt",
      "updatedAt"
    )
    values (
      ${editorUserId},
      'Publication test editor',
      ${`${editorUserId}@example.test`},
      true,
      now(),
      now()
    )
  `);
  await db.insert(workspaceMemberships).values([
    {
      workspaceId,
      userId: creatorUserId,
      role: "editor",
      source: "guest",
    },
    {
      workspaceId,
      userId: editorUserId,
      role: "editor",
      source: "guest",
    },
  ]);
  await db.insert(threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Current-run artifact publication test",
    visibility: "workspace",
    createdBy: creatorUserId,
  });
});

afterEach(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.execute(sql`delete from organization where id = ${teamId}`);
  await db.execute(sql`delete from "user" where id = ${editorUserId}`);
});

function runningToolCall(input: {
  sourceToolCallId: string;
  sourceToolName?: string;
  sequence?: number;
}) {
  return {
    id: input.sourceToolCallId,
    tool: input.sourceToolName ?? "publish_video_presentation",
    input: { title: "Test video" },
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: input.sequence ?? 1,
    producer: { kind: "main" },
  };
}

async function createRunningRun(input?: {
  actorUserId?: string;
  sourceToolCallId?: string;
  sourceToolName?: string;
  visibility?: "private" | "workspace";
}) {
  const actorUserId = input?.actorUserId ?? creatorUserId;
  const sourceToolCallId = input?.sourceToolCallId ?? randomUUID();
  const sourceToolName = input?.sourceToolName ?? "publish_video_presentation";
  const assistantMessageId = randomUUID();
  const runId = randomUUID();
  const runThreadId = randomUUID();
  const toolCall = runningToolCall({ sourceToolCallId, sourceToolName });
  await db.insert(threads).values({
    id: runThreadId,
    teamId,
    workspaceId,
    title: "Publication run thread",
    visibility: input?.visibility ?? "workspace",
    createdBy: actorUserId,
  });
  await db.insert(messages).values({
    id: assistantMessageId,
    teamId,
    workspaceId,
    threadId: runThreadId,
    role: "assistant",
    content: "",
    metadata: { toolCalls: [toolCall], renderBlocks: [] },
  });
  await db.insert(chatThreadRuns).values({
    id: runId,
    teamId,
    workspaceId,
    threadId: runThreadId,
    userId: actorUserId,
    assistantMessageId,
    idempotencyKey: `publication-run:${runId}`,
    mode: "send",
    streamKey: `chat-run-events:${runId}`,
    status: "running",
    requestJson: {},
    snapshotJson: { toolCalls: [toolCall], renderBlocks: [] },
  });
  return {
    actorUserId,
    assistantMessageId,
    runId,
    threadId: runThreadId,
    sourceToolCallId,
    sourceToolName,
  };
}

function publicationInput(
  run: Awaited<ReturnType<typeof createRunningRun>>,
  overrides: Partial<CurrentRunArtifactPublicationInput["artifact"]> = {},
): CurrentRunArtifactPublicationInput {
  return {
    context: {
      actorUserId: run.actorUserId,
      producer: { kind: "main" },
      runId: run.runId,
      sourceToolCallId: run.sourceToolCallId,
      sourceToolName: run.sourceToolName,
      teamId,
      workspaceId,
    },
    artifact: {
      artifactType: "video_presentation",
      mode: { kind: "create" },
      payload: {
        project: { title: "Atomic publication" },
        workflowVersion: "video-presentation-agent",
      },
      prompt: "Create an atomic video",
      semanticRequestKey: `publish:${randomUUID()}`,
      title: "Atomic publication",
      workflowVersion: "video-presentation-agent",
      ...overrides,
    },
  };
}

async function readRunAndMessage(run: {
  assistantMessageId: string;
  runId: string;
}) {
  const [runRow] = await db
    .select({ snapshotJson: chatThreadRuns.snapshotJson })
    .from(chatThreadRuns)
    .where(eq(chatThreadRuns.id, run.runId));
  const [messageRow] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, run.assistantMessageId));
  return {
    run: runRow?.snapshotJson ?? {},
    message: messageRow?.metadata ?? {},
  };
}

async function artifactsForRequest(requestKey: string) {
  return db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, teamId),
        eq(artifacts.workspaceId, workspaceId),
        eq(artifacts.requestKey, requestKey),
      ),
    );
}

test("create commits artifact, exact version, canonical output, and one card atomically", async () => {
  const run = await createRunningRun();
  const notify = vi.fn().mockResolvedValue(undefined);
  const service = createCurrentRunArtifactPublicationService({ notify });
  const input = publicationInput(run);

  const published = await service.publish(input);

  assert.equal(published.ok, true);
  assert.ok(published.ok);
  assert.equal(published.reused, false);
  assert.equal(published.versionNo, 1);
  const [artifact] = await artifactsForRequest(
    input.artifact.semanticRequestKey,
  );
  assert.equal(artifact?.status, "ready");
  assert.equal(artifact?.currentVersionNo, 1);
  assert.deepEqual(artifact?.payloadJson, input.artifact.payload);
  const [version] = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, published.result.artifactId));
  assert.equal(version?.id, published.result.artifactVersionId);
  assert.deepEqual(version?.contentJson, input.artifact.payload);

  const projections = await readRunAndMessage(run);
  for (const projection of [projections.run, projections.message]) {
    const toolCalls = projection.toolCalls as Array<Record<string, unknown>>;
    const call = toolCalls.find((item) => item.id === run.sourceToolCallId);
    assert.equal(call?.status, "completed");
    assert.deepEqual(call?.output, published.result);
    const blocks = projection.renderBlocks as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.id, published.result.artifactOutputBlockId);
  }
  assert.equal(notify.mock.calls.length, 1);

  // A runner snapshot captured before the transaction, or finalizer metadata
  // arriving after it, must not erase the host-committed terminal output.
  const staleToolCall = runningToolCall({
    sourceToolCallId: run.sourceToolCallId,
    sourceToolName: run.sourceToolName,
  });
  await updateChatThreadRunProgress({
    runId: run.runId,
    teamId,
    workspaceId,
    snapshotJson: { toolCalls: [staleToolCall], renderBlocks: [] },
  });
  await updateMessageMetadataRecord({
    teamId,
    workspaceId,
    threadId: run.threadId,
    messageId: run.assistantMessageId,
    metadata: { toolCalls: [staleToolCall], renderBlocks: [] },
  });
  const afterStaleWrites = await readRunAndMessage(run);
  for (const projection of [afterStaleWrites.run, afterStaleWrites.message]) {
    const toolCalls = projection.toolCalls as Array<Record<string, unknown>>;
    assert.deepEqual(toolCalls[0]?.output, published.result);
    assert.equal(toolCalls[0]?.status, "completed");
    assert.equal(
      (projection.renderBlocks as Array<Record<string, unknown>>)[0]?.id,
      published.result.artifactOutputBlockId,
    );
  }
});

test("storage coordinates require a host-preallocated artifact identity", async () => {
  const run = await createRunningRun();
  const input = publicationInput(run, {
    storageKey: `workspaces/${workspaceId}/artifacts/model-chosen/file.mp4`,
  });
  const notify = vi.fn().mockResolvedValue(undefined);
  const service = createCurrentRunArtifactPublicationService({ notify });

  await assert.rejects(
    service.publish(input),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: unknown }).code === "ARTIFACT_PAYLOAD_INVALID",
  );
  assert.equal(
    (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
    0,
  );
  assert.equal(notify.mock.calls.length, 0);
});

for (const failAt of [
  "after_version_write",
  "after_tool_output_write",
  "after_message_write",
] as const) {
  test(`${failAt} rolls back artifact, version, tool output, and card`, async () => {
    const run = await createRunningRun();
    const input = publicationInput(run);
    const notify = vi.fn().mockResolvedValue(undefined);
    const service = createCurrentRunArtifactPublicationService({
      notify,
      failpoint: (stage) => {
        if (stage === failAt) {
          throw new Error(`failpoint:${stage}`);
        }
      },
    });

    await assert.rejects(service.publish(input), {
      message: `failpoint:${failAt}`,
    });
    assert.equal(notify.mock.calls.length, 0);

    assert.equal(
      (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
      0,
    );
    const projections = await readRunAndMessage(run);
    for (const projection of [projections.run, projections.message]) {
      const toolCalls = projection.toolCalls as Array<Record<string, unknown>>;
      assert.equal(toolCalls[0]?.status, "running");
      assert.equal(toolCalls[0]?.output, null);
      assert.deepEqual(projection.renderBlocks, []);
    }
  });
}

for (const failAt of [
  "after_version_write",
  "after_tool_output_write",
  "after_message_write",
] as const) {
  test(`republish ${failAt} restores the previously ready version`, async () => {
    const existingArtifactId = randomUUID();
    const originalPayload = { project: { title: "Original version" } };
    await createReadyArtifactRecord({
      artifactId: existingArtifactId,
      artifactType: "video_presentation",
      teamId,
      workspaceId,
      threadId,
      userId: creatorUserId,
      title: "Original video",
      prompt: "Original video",
      payload: originalPayload,
    });
    const run = await createRunningRun();
    const input = publicationInput(run, {
      mode: {
        kind: "republish",
        artifactId: existingArtifactId,
        expectedVersionNo: 1,
      },
    });
    const service = createCurrentRunArtifactPublicationService({
      notify: vi.fn().mockResolvedValue(undefined),
      failpoint: (stage) => {
        if (stage === failAt) {
          throw new Error(`republish-failpoint:${stage}`);
        }
      },
    });

    await assert.rejects(service.publish(input), {
      message: `republish-failpoint:${failAt}`,
    });

    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, existingArtifactId));
    assert.equal(artifact?.currentVersionNo, 1);
    assert.deepEqual(artifact?.payloadJson, originalPayload);
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, existingArtifactId));
    assert.equal(versions.length, 1);
    const projections = await readRunAndMessage(run);
    assert.deepEqual(projections.run.renderBlocks, []);
    assert.deepEqual(projections.message.renderBlocks, []);
  });
}

test("publication winning the run lock is preserved as completed before a concurrent cancel", async () => {
  const run = await createRunningRun();
  let releaseRunLock!: () => void;
  let reachedRunLock!: () => void;
  const paused = new Promise<void>((resolve) => {
    reachedRunLock = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRunLock = resolve;
  });
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
    failpoint: async (stage: CurrentRunArtifactPublicationStage) => {
      if (stage === "after_run_lock") {
        reachedRunLock();
        await release;
      }
    },
  });
  const input = publicationInput(run);

  const publishing = service.publish(input);
  await paused;
  const cancelling = requestChatThreadRunCancel({
    runId: run.runId,
    teamId,
    workspaceId,
  });
  releaseRunLock();
  const published = await publishing;
  const cancelled = await cancelling;

  assert.equal(published.ok, true);
  assert.equal(cancelled?.status, "completed");
  assert.equal(
    (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
    1,
  );

  const rejected = await service.publish(
    publicationInput(run, { semanticRequestKey: `late:${randomUUID()}` }),
  );
  assert.deepEqual(rejected, { ok: false, reason: "run_inactive" });
});

test("a cancel that wins the run-row race fences publication", async () => {
  const run = await createRunningRun();
  const input = publicationInput(run);
  const notify = vi.fn().mockResolvedValue(undefined);
  const service = createCurrentRunArtifactPublicationService({ notify });
  const cancelled = await requestChatThreadRunCancel({
    runId: run.runId,
    teamId,
    workspaceId,
  });

  const result = await service.publish(input);

  assert.equal(cancelled?.status, "cancel_requested");
  assert.deepEqual(result, { ok: false, reason: "run_inactive" });
  assert.equal(
    (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
    0,
  );
  assert.equal(notify.mock.calls.length, 0);
});

test("concurrent semantic creates across runs reuse one artifact and one version", async () => {
  const firstRun = await createRunningRun();
  const secondRun = await createRunningRun();
  const semanticRequestKey = `duplicate:${randomUUID()}`;
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const [first, second] = await Promise.all([
    service.publish(publicationInput(firstRun, { semanticRequestKey })),
    service.publish(publicationInput(secondRun, { semanticRequestKey })),
  ]);

  assert.ok(first.ok && second.ok);
  assert.equal(first.result.artifactId, second.result.artifactId);
  assert.equal(first.result.artifactVersionId, second.result.artifactVersionId);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  const rows = await artifactsForRequest(semanticRequestKey);
  assert.equal(rows.length, 1);
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, rows[0]!.id));
  assert.equal(versions.length, 1);
});

test("viewer cannot create an artifact from an active run", async () => {
  await db
    .update(workspaceMemberships)
    .set({ role: "viewer" })
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, creatorUserId),
      ),
    );
  const run = await createRunningRun();
  const input = publicationInput(run);
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const result = await service.publish(input);

  assert.deepEqual(result, { ok: false, reason: "forbidden" });
  assert.equal(
    (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
    0,
  );
});

test("semantic reuse never crosses private and workspace thread visibility", async () => {
  const privateRun = await createRunningRun({ visibility: "private" });
  const workspaceRun = await createRunningRun({ visibility: "workspace" });
  const semanticRequestKey = `visibility:${randomUUID()}`;
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const first = await service.publish(
    publicationInput(privateRun, { semanticRequestKey }),
  );
  const second = await service.publish(
    publicationInput(workspaceRun, { semanticRequestKey }),
  );

  assert.ok(first.ok && second.ok);
  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  assert.notEqual(first.result.artifactId, second.result.artifactId);
  const rows = await artifactsForRequest(semanticRequestKey);
  assert.deepEqual(rows.map((artifact) => artifact.visibility).sort(), [
    "private",
    "workspace",
  ]);
});

test("republish rejects stale versions and a visible unauthorized editor", async () => {
  const existingArtifactId = randomUUID();
  await createReadyArtifactRecord({
    artifactId: existingArtifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: creatorUserId,
    title: "Existing video",
    prompt: "Existing video",
    payload: { project: { title: "Version one" } },
  });
  const creatorRun = await createRunningRun();
  const editorRun = await createRunningRun({ actorUserId: editorUserId });
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const stale = await service.publish(
    publicationInput(creatorRun, {
      mode: {
        kind: "republish",
        artifactId: existingArtifactId,
        expectedVersionNo: 0,
      },
    }),
  );
  assert.deepEqual(stale, { ok: false, reason: "version_conflict" });

  const forbidden = await service.publish(
    publicationInput(editorRun, {
      mode: {
        kind: "republish",
        artifactId: existingArtifactId,
        expectedVersionNo: 1,
      },
    }),
  );
  assert.deepEqual(forbidden, { ok: false, reason: "forbidden" });
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, existingArtifactId));
  assert.equal(versions.length, 1);
});

test("same-call republish replay returns its committed version instead of stale conflict", async () => {
  const existingArtifactId = randomUUID();
  await createReadyArtifactRecord({
    artifactId: existingArtifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: creatorUserId,
    title: "Replayable video",
    prompt: "Replayable video",
    payload: { project: { title: "Version one" } },
  });
  const run = await createRunningRun();
  const input = publicationInput(run, {
    mode: {
      kind: "republish",
      artifactId: existingArtifactId,
      expectedVersionNo: 1,
    },
  });
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const first = await service.publish(input);
  const replay = await service.publish(input);

  assert.ok(first.ok && replay.ok);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.versionNo, 2);
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, existingArtifactId));
  assert.equal(versions.length, 2);
});

test("private republish is hidden from another user, including a workspace admin", async () => {
  const existingArtifactId = randomUUID();
  await createReadyArtifactRecord({
    artifactId: existingArtifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: creatorUserId,
    title: "Private video",
    prompt: "Private video",
    payload: { project: { title: "Private" } },
  });
  await db
    .update(artifacts)
    .set({ visibility: "private" })
    .where(eq(artifacts.id, existingArtifactId));
  await db
    .update(workspaceMemberships)
    .set({ role: "workspace_admin" })
    .where(eq(workspaceMemberships.userId, editorUserId));
  await db.execute(sql`
    insert into member (id, "organizationId", "userId", role, "createdAt")
    values (${randomUUID()}, ${teamId}, ${editorUserId}, 'member', now())
  `);
  const adminRun = await createRunningRun({ actorUserId: editorUserId });
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });

  const result = await service.publish(
    publicationInput(adminRun, {
      mode: {
        kind: "republish",
        artifactId: existingArtifactId,
        expectedVersionNo: 1,
      },
    }),
  );

  assert.deepEqual(result, { ok: false, reason: "artifact_not_found" });
});

test("workspace admin may republish a visible artifact and advances exact CAS", async () => {
  const existingArtifactId = randomUUID();
  await createReadyArtifactRecord({
    artifactId: existingArtifactId,
    artifactType: "video_presentation",
    teamId,
    workspaceId,
    threadId,
    userId: creatorUserId,
    title: "Shared video",
    prompt: "Shared video",
    payload: { project: { title: "Version one" } },
  });
  await db
    .update(workspaceMemberships)
    .set({ role: "workspace_admin" })
    .where(eq(workspaceMemberships.userId, editorUserId));
  await db.execute(sql`
    insert into member (id, "organizationId", "userId", role, "createdAt")
    values (${randomUUID()}, ${teamId}, ${editorUserId}, 'member', now())
  `);
  const adminRun = await createRunningRun({ actorUserId: editorUserId });
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockResolvedValue(undefined),
  });
  const input = publicationInput(adminRun, {
    mode: {
      kind: "republish",
      artifactId: existingArtifactId,
      expectedVersionNo: 1,
    },
  });

  const result = await service.publish(input);

  assert.ok(result.ok);
  assert.equal(result.versionNo, 2);
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, existingArtifactId));
  assert.equal(artifact?.currentVersionNo, 2);
  assert.deepEqual(artifact?.payloadJson, input.artifact.payload);
});

test("post-commit notification failure cannot erase committed publication", async () => {
  const run = await createRunningRun();
  const input = publicationInput(run);
  const service = createCurrentRunArtifactPublicationService({
    notify: vi.fn().mockRejectedValue(new Error("notify unavailable")),
  });

  const result = await service.publish(input);

  assert.equal(result.ok, true);
  assert.equal(
    (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
    1,
  );
  const projections = await readRunAndMessage(run);
  assert.equal(
    (projections.run.renderBlocks as unknown[] | undefined)?.length,
    1,
  );
});

test("notification observes committed rows, never an in-flight transaction", async () => {
  const run = await createRunningRun();
  const input = publicationInput(run);
  let observed!: (count: number) => void;
  const notificationObserved = new Promise<number>((resolve) => {
    observed = resolve;
  });
  const service = createCurrentRunArtifactPublicationService({
    notify: async () => {
      observed(
        (await artifactsForRequest(input.artifact.semanticRequestKey)).length,
      );
    },
  });

  const result = await service.publish(input);

  assert.equal(result.ok, true);
  assert.equal(await notificationObserved, 1);
});
