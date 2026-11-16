import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  parseStudyContentForArtifact,
  studyFingerprint,
  type StudyContent,
} from "@sourceweft/contracts/study";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../content/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content/queue")>()),
  enqueueStudyGenerateJob: enqueue,
}));

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let requests: typeof import("./requests");
let job: typeof import("./job");
let engine: typeof import("@sourceweft/contracts/study-capability");
let capability: typeof import("./capability");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let userId: string;
let threadId: string;
let sourceId: string;
let documentId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("study_generation");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  requests = await import("./requests");
  job = await import("./job");
  engine = await import("@sourceweft/contracts/study-capability");
  capability = await import("./capability");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, userId, threadId] = [
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
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Study",
    slug: workspaceId,
  });
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
    title: "Study thread",
    visibility: "private",
    createdBy: userId,
  });
  sourceId = `src_${randomUUID()}`;
  documentId = `doc_${randomUUID()}`;
  await schema.db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    title: "Biology notes",
    contentText: "FACT-1 cells.",
    contentHash: "hash-1",
    status: "indexed",
  });
  await schema.db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId,
    sourceId,
    contentText: "FACT-1 cells.",
    status: "ready",
  });
  await schema.db.insert(schema.chunks).values({
    id: `chk_${randomUUID()}`,
    teamId,
    workspaceId,
    sourceId,
    documentId,
    chunkNo: 0,
    content: "FACT-1 cells divide by mitosis in most tissues of the body.",
  });
});

afterEach(async () => {
  if (!schema) return;
  await schema.db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await schema.database.query("delete from organization where id = $1", [teamId]);
  await schema.database.query('delete from "user" where id = $1', [userId]);
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function generateRequest(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    userId,
    uiLocale: "en",
    request: {
      threadId,
      artifactType: "quiz" as const,
      sourceIds: [sourceId],
      options: { size: "fewer" as const },
      visibility: "workspace" as const,
      ...overrides,
    },
  };
}

function quizContent(stems: string[], fingerprintIds: Record<string, string> = {}): StudyContent {
  return {
    schemaVersion: 1,
    kind: "quiz",
    language: "en",
    inputs: {
      selection: "sources",
      sources: [{ sourceId, documentId, contentHash: "hash-1" }],
    },
    generation: {
      promptVersion: "quiz-v1",
      modelAlias: "test-model",
      mode: "single",
      stats: { requested: stems.length, kept: stems.length, dropped: {}, groups: 1, tokensEstimated: 20 },
      recipe: { options: { size: "fewer", difficulty: "hard" }, focus: "cells", sourceIds: [sourceId] },
    },
    items: stems.map((stem) => {
      const fingerprint = studyFingerprint("quiz", stem);
      return {
        id: fingerprintIds[fingerprint] ?? `q_${randomUUID().replaceAll("-", "")}`,
        fingerprint,
        type: "single" as const,
        stem,
        options: ["Mitosis", "Meiosis"],
        correct: [0],
        explanation: "FACT-1 cells divide by mitosis.",
        difficulty: 2 as const,
        evidence: [
          {
            kind: "chunk" as const,
            sourceId,
            documentId,
            chunkId: "chk",
            quote: "FACT-1 cells divide by mitosis",
            quoteHash: `sha256:${"a".repeat(64)}`,
          },
        ],
      };
    }),
  };
}

function stubGenerate(content: StudyContent) {
  return vi.fn(async () => ({
    content,
    stats: content.generation.stats,
    mode: "single" as const,
    payer: { userId, billingOrganizationId: teamId },
    sources: [{ sourceId, documentId, title: "Biology notes", contentHash: "hash-1" }],
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
    artifactType: "quiz" as const,
    sourceIds: [sourceId],
    uiLocale: "en",
    isFinalAttempt: false,
    scopeId: `job-${versionNo}`,
    ...extra,
  };
}

test("a request opens a pending artifact in its thread's visibility and queues version 1", async () => {
  const result = await requests.requestStudyArtifact(generateRequest());
  assert.equal(result.status, "pending");
  assert.equal(result.versionNo, 1);
  // The thread is private, so the artifact is private whatever was asked.
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
  });
  const row = await artifactRow(result.artifactId);
  assert.equal(row.status, "pending");
  assert.equal(row.artifactType, "quiz");
});

test("the same request twice opens one artifact and queues once", async () => {
  const first = await requests.requestStudyArtifact(generateRequest());
  const second = await requests.requestStudyArtifact(generateRequest());
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.reused, true);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test("a source from another workspace is SOURCE_NOT_READABLE and nothing is opened", async () => {
  await assert.rejects(
    requests.requestStudyArtifact(generateRequest({ sourceIds: [sourceId, "src_foreign"] })),
    (error: unknown) =>
      (error as { code?: string; statusCode?: number }).code === "SOURCE_NOT_READABLE" &&
      (error as { statusCode?: number }).statusCode === 404,
  );
  expect(enqueue).not.toHaveBeenCalled();
});

test("a fourth concurrent generation is refused with 429", async () => {
  for (const size of ["fewer", "standard", "more"] as const) {
    await requests.requestStudyArtifact(generateRequest({ options: { size } }));
  }
  await assert.rejects(
    requests.requestStudyArtifact(generateRequest({ options: { count: 7 } })),
    (error: unknown) =>
      (error as { code?: string }).code === "STUDY_TOO_MANY_RUNNING" &&
      (error as { statusCode?: number }).statusCode === 429,
  );
});

test("the estimate reports size without any model call", async () => {
  const estimate = await requests.estimateStudy(generateRequest());
  assert.deepEqual(estimate, {
    mode: "single",
    inputTokensEstimate: (await capability.loadStudyGeneration()).estimateTokens(
      "FACT-1 cells divide by mitosis in most tissues of the body.",
    ),
    groups: 1,
    maxItems: 5,
    exceedsLimit: false,
  });
});

test("the job publishes version 1, records its input sources, and the content reads back", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  const content = quizContent(["Q one?", "Q two?", "Q three?"]);
  const result = await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(content),
  });
  assert.deepEqual(result, { status: "ready", versionNo: 1 });
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.status, "ready");
  assert.equal(row.currentVersionNo, 1);
  const [version] = await versionRows(opened.artifactId);
  assert.deepEqual(parseStudyContentForArtifact("quiz", version!.contentJson), content);
  const sources = await schema.db
    .select()
    .from(schema.artifactSources)
    .where(
      and(
        eq(schema.artifactSources.artifactId, opened.artifactId),
        eq(schema.artifactSources.role, "input"),
      ),
    );
  assert.deepEqual(sources.map((s) => s.sourceId), [sourceId]);
});

test("a failure no retry can fix is recorded on the first attempt", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  const generate = vi.fn(async () => {
    throw new engine.StudyGenerationError("INSUFFICIENT_CREDITS", "no credits");
  });
  const result = await job.processStudyJob(jobPayload(opened.artifactId), {
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
  const opened = await requests.requestStudyArtifact(generateRequest());
  const generate = vi.fn(async () => {
    throw new Error("upstream 502");
  });
  await assert.rejects(
    job.processStudyJob(jobPayload(opened.artifactId), { billing: {} as never, generate }),
    /upstream 502/,
  );
  assert.equal((await artifactRow(opened.artifactId)).status, "running");
  const result = await job.processStudyJob(
    jobPayload(opened.artifactId, 1, { isFinalAttempt: true }),
    { billing: {} as never, generate },
  );
  assert.deepEqual(result, { status: "failed", errorCode: "MODEL_UNAVAILABLE" });
  assert.equal((await artifactRow(opened.artifactId)).errorCode, "MODEL_UNAVAILABLE");
});

test("regeneration publishes version 2 from the recipe, keeps version 1 and passes the old ids", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  const first = quizContent(["Q one?", "Q two?", "Q three?"]);
  await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(first),
  });
  enqueue.mockClear();

  const regen = await requests.requestStudyRegeneration({
    workspaceId,
    userId,
    artifactId: opened.artifactId,
    uiLocale: "en",
    body: { options: { difficulty: "easy" } },
  });
  assert.equal(regen.versionNo, 2);
  const queued = enqueue.mock.calls[0]![0];
  // Missing fields come from the recipe; the request overrides the rest.
  assert.deepEqual(queued.options, { size: "fewer", difficulty: "easy", focus: "cells" });
  assert.deepEqual(queued.sourceIds, [sourceId]);

  const previousIds = Object.fromEntries(
    (first.kind === "quiz" ? first.items : []).map((item) => [item.fingerprint, item.id]),
  );
  const second = quizContent(["Q one?", "Q four?", "Q five?"], previousIds);
  const generate = stubGenerate(second);
  const result = await job.processStudyJob(jobPayload(opened.artifactId, 2, queued), {
    billing: {} as never,
    generate,
  });
  assert.deepEqual(result, { status: "ready", versionNo: 2 });
  const passed = (generate.mock.calls[0] as unknown as [{ previousIds: Map<string, string> }])[0]
    .previousIds;
  assert.equal(passed.get(studyFingerprint("quiz", "Q one?")), previousIds[studyFingerprint("quiz", "Q one?")]);

  const versions = await versionRows(opened.artifactId);
  assert.deepEqual(versions.map((v) => v.versionNo), [1, 2]);
  assert.equal(versions[1]!.parentVersionId, versions[0]!.id);
  assert.deepEqual(parseStudyContentForArtifact("quiz", versions[0]!.contentJson), first);
  assert.equal((await artifactRow(opened.artifactId)).currentVersionNo, 2);
});

test("a second regeneration of the same version is a conflict", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(quizContent(["Q one?", "Q two?", "Q three?"])),
  });
  enqueue.mockReset().mockResolvedValueOnce({ created: true }).mockResolvedValueOnce({ created: false });
  const input = { workspaceId, userId, artifactId: opened.artifactId, uiLocale: "en", body: {} };
  await requests.requestStudyRegeneration(input);
  await assert.rejects(
    requests.requestStudyRegeneration(input),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );
});

test("a failed regeneration leaves the ready version in place", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(quizContent(["Q one?", "Q two?", "Q three?"])),
  });
  const result = await job.processStudyJob(jobPayload(opened.artifactId, 2), {
    billing: {} as never,
    generate: vi.fn(async () => {
      throw new engine.StudyGenerationError("GENERATION_QUALITY_TOO_LOW", "too few");
    }),
  });
  assert.deepEqual(result, { status: "failed", errorCode: "GENERATION_QUALITY_TOO_LOW" });
  const row = await artifactRow(opened.artifactId);
  assert.equal(row.status, "ready");
  assert.equal(row.currentVersionNo, 1);
  assert.deepEqual((row.payloadJson.study as Record<string, unknown>).regeneration, {
    versionNo: 2,
    status: "failed",
    errorCode: "GENERATION_QUALITY_TOO_LOW",
  });
});

test("a job for a version that is already published is skipped", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  const generate = stubGenerate(quizContent(["Q one?", "Q two?", "Q three?"]));
  await job.processStudyJob(jobPayload(opened.artifactId), { billing: {} as never, generate });
  const again = await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate,
  });
  assert.equal(again.status, "skipped");
  expect(generate).toHaveBeenCalledTimes(1);
});

test("freshness follows the source hash and its deletion", async () => {
  const opened = await requests.requestStudyArtifact(generateRequest());
  await job.processStudyJob(jobPayload(opened.artifactId), {
    billing: {} as never,
    generate: stubGenerate(quizContent(["Q one?", "Q two?", "Q three?"])),
  });
  const read = () =>
    requests.getStudyFreshness({ workspaceId, userId, artifactId: opened.artifactId });
  assert.equal((await read()).state, "fresh");
  await schema.db.update(schema.sources).set({ contentHash: "hash-2" }).where(eq(schema.sources.id, sourceId));
  assert.deepEqual(await read(), { state: "stale", changedSourceIds: [sourceId], deletedSourceIds: [] });
  await schema.db.delete(schema.sources).where(eq(schema.sources.id, sourceId));
  assert.equal((await read()).state, "source_deleted");
});
