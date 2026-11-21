import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseTableContent, type TableContent } from "@sourceweft/contracts/table";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { tableContentFixture } from "./test-support";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../content/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content/queue")>()),
  enqueueTableGenerateJob: enqueue,
  enqueueStudyGenerateJob: vi.fn().mockResolvedValue({ created: true }),
}));

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let requests: typeof import("./requests");
let job: typeof import("./job");
let repository: typeof import("./repository");
let summaries: typeof import("./summaries");
let loader: typeof import("./corpus-loader");
let studyRequests: typeof import("../study/requests");
let engine: typeof import("@sourceweft/contracts/table-capability");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let threadId: string;
let sourceId: string;
let documentId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("table_generation");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  requests = await import("./requests");
  job = await import("./job");
  repository = await import("./repository");
  summaries = await import("./summaries");
  loader = await import("./corpus-loader");
  studyRequests = await import("../study/requests");
  engine = await import("@sourceweft/contracts/table-capability");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, otherWorkspaceId, userId, threadId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  enqueue.mockReset().mockResolvedValue({ created: true });
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values([
    { id: workspaceId, organizationId: teamId, name: "Tables", slug: workspaceId },
    { id: otherWorkspaceId, organizationId: teamId, name: "Other", slug: otherWorkspaceId },
  ]);
  await schema.database.query(
    'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now())',
    [userId, `${userId}@example.test`],
  );
  await schema.db
    .insert(schema.workspaceMemberships)
    .values({ workspaceId, userId, role: "editor", source: "guest" });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Table thread",
    visibility: "private",
    createdBy: userId,
  });
  ({ sourceId, documentId } = await addSource({
    title: "Trial report",
    chunks: ["Atlas was a randomised trial with 1,200 participants."],
    hash: "hash-1",
  }));
});

afterEach(async () => {
  if (!schema) return;
  for (const id of [workspaceId, otherWorkspaceId]) {
    await schema.db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  }
  await schema.database.query("delete from organization where id = $1", [teamId]);
  await schema.database.query('delete from "user" where id = $1', [userId]);
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function addSource(input: {
  workspace?: string;
  title: string;
  status?: "indexed" | "processing";
  chunks?: string[];
  hash?: string | null;
  text?: string;
}) {
  const ws = input.workspace ?? workspaceId;
  const id = `src_${randomUUID()}`;
  const docId = `doc_${randomUUID()}`;
  const text = input.text ?? (input.chunks ?? []).join("\n");
  await schema.db.insert(schema.sources).values({
    id,
    teamId,
    workspaceId: ws,
    title: input.title,
    contentText: text,
    contentHash: input.hash === undefined ? `hash-${id}` : input.hash,
    status: input.status ?? "indexed",
  });
  await schema.db.insert(schema.documents).values({
    id: docId,
    teamId,
    workspaceId: ws,
    sourceId: id,
    contentText: text,
    status: "ready",
  });
  if (input.chunks?.length) {
    await schema.db.insert(schema.chunks).values(
      input.chunks.map((content, chunkNo) => ({
        id: `chk_${randomUUID()}`,
        teamId,
        workspaceId: ws,
        sourceId: id,
        documentId: docId,
        chunkNo,
        content,
        headingPath: `H${chunkNo}`,
        language: "en",
      })),
    );
  }
  return { sourceId: id, documentId: docId };
}

const columns = [
  { name: "Design", description: "Study design", type: "text" as const },
  { name: "Participants", type: "number" as const },
];

function generateRequest(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    userId,
    uiLocale: "en",
    request: {
      threadId,
      sourceIds: [sourceId],
      columns,
      visibility: "workspace" as const,
      ...overrides,
    },
  };
}

function storedContent(extra: { sources?: { sourceId: string; documentId: string; contentHash: string }[] } = {}) {
  return tableContentFixture({
    sources: extra.sources ?? [{ sourceId, documentId, contentHash: "hash-1" }],
    columns,
    instruction: "trials",
  });
}

function stubGenerate(content: TableContent) {
  return vi.fn(async () => ({
    content,
    stats: content.generation.stats,
    payer: { userId, billingOrganizationId: teamId },
    sources: content.rows.map((row) => ({
      sourceId: row.sourceId,
      documentId: row.documentId,
      title: row.title,
      contentHash: row.contentHash,
    })),
    durationMs: 1,
  }));
}

async function artifactRow(artifactId: string) {
  const [row] = await schema.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  return row!;
}

async function versionRows(artifactId: string) {
  return schema.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifactId))
    .orderBy(schema.artifactVersions.versionNo);
}

function jobPayload(artifactId: string, versionNo = 1, extra: Record<string, unknown> = {}) {
  return {
    teamId,
    workspaceId,
    threadId,
    artifactId,
    versionNo,
    userId,
    sourceIds: [sourceId],
    columns,
    uiLocale: "en",
    isFinalAttempt: false,
    scopeId: `job-${versionNo}`,
    ...extra,
  };
}

/* ----------------------------------------------------------------- request */

test("a request opens a pending table in its thread's visibility and queues version 1", async () => {
  const result = await requests.requestTableArtifact(generateRequest());
  assert.equal(result.status, "pending");
  assert.equal(result.versionNo, 1);
  // The thread is private, so the table is private whatever was asked.
  assert.equal(result.visibility, "private");
  assert.equal(result.reused, false);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0]![0]).toMatchObject({
    artifactId: result.artifactId,
    versionNo: 1,
    teamId,
    workspaceId,
    threadId,
    userId,
    sourceIds: [sourceId],
  });
  const row = await artifactRow(result.artifactId);
  assert.equal(row.status, "pending");
  assert.equal(row.artifactType, "table");
  assert.deepEqual((row.payloadJson.table as Record<string, unknown>).progress, {
    stage: "fill",
    done: 0,
    total: 1,
  });
});

test("the same request twice opens one table and queues once", async () => {
  const first = await requests.requestTableArtifact(generateRequest());
  const second = await requests.requestTableArtifact(generateRequest());
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.reused, true);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test("a source from another workspace is SOURCE_NOT_READABLE and nothing is opened", async () => {
  const foreign = await addSource({ workspace: otherWorkspaceId, title: "Foreign", chunks: ["y"] });
  await assert.rejects(
    requests.requestTableArtifact(generateRequest({ sourceIds: [sourceId, foreign.sourceId] })),
    (error: unknown) =>
      (error as { code?: string }).code === "SOURCE_NOT_READABLE" &&
      (error as { statusCode?: number }).statusCode === 404,
  );
  expect(enqueue).not.toHaveBeenCalled();
  const rows = await schema.db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.workspaceId, workspaceId));
  assert.equal(rows.length, 0);
});

test("study and table generations share one running limit per person, in both directions", async () => {
  const studyRequest = (count: number) => ({
    workspaceId,
    userId,
    uiLocale: "en",
    request: {
      threadId,
      artifactType: "quiz" as const,
      sourceIds: [sourceId],
      options: { count },
    },
  });
  await studyRequests.requestStudyArtifact(studyRequest(5));
  await studyRequests.requestStudyArtifact(studyRequest(6));
  await requests.requestTableArtifact(generateRequest());
  // Two study and one table in flight: a fourth of either kind is refused.
  await assert.rejects(
    requests.requestTableArtifact(generateRequest({ instruction: "another" })),
    (error: unknown) =>
      (error as { code?: string }).code === "TABLE_TOO_MANY_RUNNING" &&
      (error as { statusCode?: number }).statusCode === 429,
  );
  await assert.rejects(
    studyRequests.requestStudyArtifact(studyRequest(7)),
    (error: unknown) => (error as { code?: string }).code === "STUDY_TOO_MANY_RUNNING",
  );
  // The same table request again starts nothing, so it is not refused.
  const again = await requests.requestTableArtifact(generateRequest());
  assert.equal(again.reused, true);
});

test("a table being regenerated counts as running; a failed one stops counting", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(storedContent()),
  });
  const { countRunningGroundedJobs } = await import("../grounded-generation/artifact-store");
  const count = () => countRunningGroundedJobs({ teamId, workspaceId, userId });
  assert.equal(await count(), 0);
  await requests.requestTableRegeneration({
    workspaceId,
    userId,
    artifactId: opened.artifactId,
    uiLocale: "en",
    body: {},
  });
  assert.equal(await count(), 1);
  await job.processTableJob(jobPayload(opened.artifactId, 2), {
    billing: {} as never,
    generate: vi.fn(async () => {
      throw new engine.TableGenerationError("INSUFFICIENT_CREDITS", "no credits");
    }),
  });
  assert.equal(await count(), 0);
});

/* --------------------------------------------------------------------- job */

test("version 1 completes a pending artifact with table content and records its input sources", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const content = storedContent();
  const generate = stubGenerate(content);
  const result = await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate,
  });
  assert.deepEqual(result, { status: "ready", versionNo: 1 });
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.status, "ready");
  assert.equal(row.currentVersionNo, 1);
  const [version] = await versionRows(opened.artifactId);
  assert.deepEqual(parseTableContent(version!.contentJson), content);
  const recorded = await schema.db
    .select()
    .from(schema.artifactSources)
    .where(
      and(
        eq(schema.artifactSources.artifactId, opened.artifactId),
        eq(schema.artifactSources.role, "input"),
      ),
    );
  assert.deepEqual(recorded.map((source) => source.sourceId), [sourceId]);
  // What the engine was asked for comes from the queued request.
  const [request] = generate.mock.calls[0] as unknown as [Record<string, unknown>];
  assert.deepEqual(
    { sourceIds: request.sourceIds, columns: request.columns, versionNo: request.versionNo },
    { sourceIds: [sourceId], columns, versionNo: 1 },
  );
  assert.equal(request.previous, undefined);
  assert.equal(request.artifactId, opened.artifactId);
  assert.equal(request.scopeId, "job-1");
});

test("a failure no retry can fix is recorded on the first attempt", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const generate = vi.fn(async () => {
    throw new engine.TableGenerationError("INSUFFICIENT_CREDITS", "no credits");
  });
  const result = await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate,
  });
  assert.deepEqual(result, { status: "failed", errorCode: "INSUFFICIENT_CREDITS" });
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "INSUFFICIENT_CREDITS");
  expect(generate).toHaveBeenCalledTimes(1);
});

test("a transient failure is retried, and recorded as MODEL_UNAVAILABLE only on the last attempt", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const generate = vi.fn(async () => {
    throw new Error("upstream 502");
  });
  await assert.rejects(
    job.processTableJob(jobPayload(opened.artifactId), { billing: {} as never, generate }),
    /upstream 502/,
  );
  assert.equal((await artifactRow(opened.artifactId)).status, "running");
  const result = await job.processTableJob(
    jobPayload(opened.artifactId, 1, { isFinalAttempt: true }),
    { billing: {} as never, generate },
  );
  assert.deepEqual(result, { status: "failed", errorCode: "MODEL_UNAVAILABLE" });
});

test("regeneration hands the parsed previous version to the engine and publishes version 2 beside version 1", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const first = storedContent();
  await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(first),
  });
  enqueue.mockClear();
  const regen = await requests.requestTableRegeneration({
    workspaceId,
    userId,
    artifactId: opened.artifactId,
    uiLocale: "en",
    body: { instruction: "events" },
  });
  assert.equal(regen.versionNo, 2);
  const queued = enqueue.mock.calls[0]![0];
  assert.deepEqual(queued.sourceIds, [sourceId]);
  assert.deepEqual(queued.columns, first.generation.recipe.columns);
  assert.equal(queued.instruction, "events");

  const second = { ...first, rows: first.rows.map((row) => ({ ...row })) };
  const generate = stubGenerate(second);
  const result = await job.processTableJob(jobPayload(opened.artifactId, 2, queued), {
    billing: {} as never,
    generate,
  });
  assert.deepEqual(result, { status: "ready", versionNo: 2 });
  const [request] = generate.mock.calls[0] as unknown as [{ previous?: TableContent }];
  assert.deepEqual(request.previous, first);

  const versions = await versionRows(opened.artifactId);
  assert.deepEqual(versions.map((v) => v.versionNo), [1, 2]);
  assert.equal(versions[1]!.parentVersionId, versions[0]!.id);
  assert.deepEqual(parseTableContent(versions[0]!.contentJson), first);
  assert.equal((await artifactRow(opened.artifactId)).currentVersionNo, 2);
});

test("a previous version that cannot be read is no previous version", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(storedContent()),
  });
  await schema.db
    .update(schema.artifactVersions)
    .set({ contentJson: { kind: "table", broken: true } })
    .where(eq(schema.artifactVersions.artifactId, opened.artifactId));
  const generate = stubGenerate(storedContent());
  const result = await job.processTableJob(jobPayload(opened.artifactId, 2), {
    billing: {} as never,
    generate,
  });
  assert.equal(result.status, "ready");
  const [request] = generate.mock.calls[0] as unknown as [{ previous?: TableContent }];
  assert.equal(request.previous, undefined);
});

test("a failed regeneration keeps the ready version and records payload_json.table.regeneration", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(storedContent()),
  });
  const result = await job.processTableJob(jobPayload(opened.artifactId, 2), {
    billing: {} as never,
    generate: vi.fn(async () => {
      throw new engine.TableGenerationError("GENERATION_QUALITY_TOO_LOW", "too many unverified");
    }),
  });
  assert.deepEqual(result, { status: "failed", errorCode: "GENERATION_QUALITY_TOO_LOW" });
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.status, "ready");
  assert.equal(row.currentVersionNo, 1);
  assert.deepEqual((row.payloadJson.table as Record<string, unknown>).regeneration, {
    versionNo: 2,
    status: "failed",
    errorCode: "GENERATION_QUALITY_TOO_LOW",
  });
  assert.equal((await versionRows(opened.artifactId)).length, 1);
});

test("a job for a version that is already published is skipped", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const generate = stubGenerate(storedContent());
  await job.processTableJob(jobPayload(opened.artifactId), { billing: {} as never, generate });
  const again = await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate,
  });
  assert.equal(again.status, "skipped");
  expect(generate).toHaveBeenCalledTimes(1);
});

test("the checkpoint and progress live in payload_json.table and leave the rest, and study's key, alone", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  const scope = { artifactId: opened.artifactId, teamId, workspaceId };
  await schema.db
    .update(schema.artifacts)
    .set({ payloadJson: { keep: "me", study: { progress: { stage: "assemble" } } } })
    .where(eq(schema.artifacts.id, opened.artifactId));
  const store = repository.createArtifactCheckpointStore(scope);
  assert.equal(await store.load(), null);
  const checkpoint = { versionNo: 2, rows: {} };
  await store.save(checkpoint);
  await repository.writeTableProgress(scope, { stage: "fill", done: 1, total: 3 });
  assert.deepEqual(await store.load(), checkpoint);
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.payloadJson.keep, "me");
  assert.deepEqual(row.payloadJson.study, { progress: { stage: "assemble" } });
  assert.deepEqual((row.payloadJson.table as Record<string, unknown>).progress, {
    stage: "fill",
    done: 1,
    total: 3,
  });
  // Another workspace's scope cannot read it, and a stored value of the wrong
  // shape is no checkpoint.
  const stranger = repository.createArtifactCheckpointStore({ ...scope, workspaceId: otherWorkspaceId });
  assert.equal(await stranger.load(), null);
  await repository.writeTablePayloadKey(scope, "checkpoint", { versionNo: "x" });
  assert.equal(await store.load(), null);
});

/* --------------------------------------------------------------- freshness */

test("freshness reports a changed source as stale and a deleted source as source_deleted", async () => {
  const second = await addSource({ title: "Second", chunks: ["b"], hash: "hash-2" });
  const opened = await requests.requestTableArtifact(
    generateRequest({ sourceIds: [sourceId, second.sourceId] }),
  );
  await job.processTableJob(jobPayload(opened.artifactId, 1, { sourceIds: [sourceId, second.sourceId] }), {
    billing: {} as never,
    generate: stubGenerate(
      storedContent({
        sources: [
          { sourceId, documentId, contentHash: "hash-1" },
          { sourceId: second.sourceId, documentId: second.documentId, contentHash: "hash-2" },
        ],
      }),
    ),
  });
  const read = () => requests.getTableFreshness({ workspaceId, userId, artifactId: opened.artifactId });
  assert.deepEqual(await read(), { state: "fresh", changedSourceIds: [], deletedSourceIds: [] });
  await schema.db.update(schema.sources).set({ contentHash: "hash-new" }).where(eq(schema.sources.id, sourceId));
  assert.deepEqual(await read(), { state: "stale", changedSourceIds: [sourceId], deletedSourceIds: [] });
  await schema.db.delete(schema.sources).where(eq(schema.sources.id, second.sourceId));
  assert.deepEqual(await read(), {
    state: "source_deleted",
    changedSourceIds: [sourceId],
    deletedSourceIds: [second.sourceId],
  });
});

test("an uploaded file without a content hash reads fresh after generation; a new upload marks it changed, a parse retry does not", async () => {
  const { loadSourceVersionTokens } = await import("../grounded-generation/freshness");
  const upload = await addSource({ title: "Upload", chunks: ["u"], hash: null });
  const tokenNow = async () =>
    (await loadSourceVersionTokens({ teamId, workspaceId, ids: [upload.sourceId] })).get(upload.sourceId);

  // What generation stores and what freshness reads are the same token.
  const loaded = await loader.loadTableSources({ teamId, workspaceId, sourceIds: [upload.sourceId] });
  const stored = loaded.sources[0]!.contentHash;
  assert.equal(stored, `document:${upload.documentId}`);
  assert.equal(await tokenNow(), stored);

  const opened = await requests.requestTableArtifact(generateRequest({ sourceIds: [upload.sourceId] }));
  await job.processTableJob(jobPayload(opened.artifactId, 1, { sourceIds: [upload.sourceId] }), {
    billing: {} as never,
    generate: stubGenerate(
      storedContent({
        sources: [{ sourceId: upload.sourceId, documentId: upload.documentId, contentHash: stored }],
      }),
    ),
  });
  const read = () => requests.getTableFreshness({ workspaceId, userId, artifactId: opened.artifactId });
  assert.deepEqual(await read(), { state: "fresh", changedSourceIds: [], deletedSourceIds: [] });

  // A new upload: a revision with its own document.
  const revisionId = `rev_${randomUUID()}`;
  await schema.db.insert(schema.sourceRevisions).values({
    id: revisionId,
    teamId,
    workspaceId,
    sourceId: upload.sourceId,
    revisionNo: 1,
  });
  const addDocument = (secondsLater: number) =>
    schema.db.insert(schema.documents).values({
      id: `doc_${randomUUID()}`,
      teamId,
      workspaceId,
      sourceId: upload.sourceId,
      sourceRevisionId: revisionId,
      contentText: "u2",
      status: "ready",
      createdAt: new Date(Date.now() + secondsLater * 1_000),
    });
  await addDocument(1);
  assert.equal(await tokenNow(), `revision:${revisionId}`);
  assert.deepEqual(await read(), {
    state: "stale",
    changedSourceIds: [upload.sourceId],
    deletedSourceIds: [],
  });

  // Parsing the same upload again makes a newer document in the same revision.
  await addDocument(2);
  assert.equal(await tokenNow(), `revision:${revisionId}`);
});

test("freshness of a table nobody can see, or of another type, is not found", async () => {
  const opened = await requests.requestTableArtifact(generateRequest());
  await job.processTableJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(storedContent()),
  });
  await assert.rejects(
    requests.getTableFreshness({ workspaceId, userId: "someone-else", artifactId: opened.artifactId }),
  );
  await schema.db
    .update(schema.artifacts)
    .set({ artifactType: "quiz" })
    .where(eq(schema.artifacts.id, opened.artifactId));
  await assert.rejects(
    requests.getTableFreshness({ workspaceId, userId, artifactId: opened.artifactId }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
  );
});

/* ------------------------------------------------------- sources and sizing */

test("source summaries come from the guide when there is one, else the first 1,200 characters", async () => {
  const withGuide = await addSource({ title: "Guided", chunks: ["body"], text: "G".repeat(3_000) });
  const plain = await addSource({ title: "Plain", chunks: ["body"], text: "P".repeat(3_000) });
  const short = await addSource({ title: "Short", chunks: ["body"], text: "tiny" });
  await schema.db.insert(schema.sourceGuides).values({
    id: `guide_${randomUUID()}`,
    teamId,
    workspaceId,
    sourceId: withGuide.sourceId,
    status: "ready",
    trigger: "auto",
    contentJson: { summary: "A guided summary.", topics: [], suggestedQuestions: [] },
  });
  const result = await summaries.loadSourceSummaries({
    teamId,
    workspaceId,
    sourceIds: [plain.sourceId, withGuide.sourceId, short.sourceId],
  });
  assert.deepEqual(result, [
    { sourceId: plain.sourceId, title: "Plain", summary: "P".repeat(1_200) },
    { sourceId: withGuide.sourceId, title: "Guided", summary: "A guided summary." },
    { sourceId: short.sourceId, title: "Short", summary: "tiny" },
  ]);
  // A source of another workspace is not readable.
  const foreign = await addSource({ workspace: otherWorkspaceId, title: "F", chunks: ["f"] });
  await assert.rejects(
    summaries.loadSourceSummaries({ teamId, workspaceId, sourceIds: [foreign.sourceId] }),
    (error: unknown) => (error as { code?: string }).code === "SOURCE_NOT_READABLE",
  );
});

test("loading sources keeps selection order, and a source that is not indexed becomes a skipped row without a snapshot", async () => {
  const busy = await addSource({ title: "Busy", status: "processing", chunks: ["p"], hash: null });
  const second = await addSource({ title: "Second", chunks: ["s0", "s1"] });
  const loaded = await loader.loadTableSources({
    teamId,
    workspaceId,
    sourceIds: [second.sourceId, busy.sourceId, sourceId],
  });
  assert.deepEqual(
    loaded.sources.map((source) => [source.sourceId, source.indexed, source.chunks.length]),
    [
      [second.sourceId, true, 2],
      [busy.sourceId, false, 0],
      [sourceId, true, 1],
    ],
  );
  const skipped = loaded.sources[1]!;
  assert.equal(skipped.title, "Busy");
  // No hash yet reads as stale against any real hash later.
  assert.equal(skipped.contentHash, "unknown");
  assert.ok(skipped.documentId.length > 0);
  assert.deepEqual(
    loaded.snapshots.map((snapshot) => snapshot.sourceId),
    [second.sourceId, sourceId],
  );
  await assert.rejects(
    loader.loadTableSources({ teamId, workspaceId, sourceIds: [busy.sourceId] }),
    (error: unknown) => (error as { code?: string }).code === "NO_INDEXED_SOURCES",
  );
});

test("the estimate counts calls and cells without any model call", async () => {
  const second = await addSource({ title: "Second", chunks: ["more text"] });
  const busy = await addSource({ title: "Busy", status: "processing", chunks: ["p"] });
  const estimate = await requests.estimateTable(
    generateRequest({ sourceIds: [sourceId, second.sourceId, busy.sourceId] }),
  );
  assert.equal(estimate.sources, 3);
  assert.equal(estimate.skippedSources, 1);
  assert.equal(estimate.columns, 2);
  assert.equal(estimate.cells, 4);
  assert.equal(estimate.calls, 2);
  assert.ok(estimate.inputTokensEstimate > 0);
  assert.equal(estimate.exceedsLimit, false);
});
