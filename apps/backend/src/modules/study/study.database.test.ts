import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let loader: typeof import("./corpus-loader");
let repository: typeof import("./repository");
let freshness: typeof import("./freshness");
let engine: typeof import("@sourceweft/contracts/study-capability");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("study_engine");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  loader = await import("./corpus-loader");
  repository = await import("./repository");
  freshness = await import("./freshness");
  engine = await import("@sourceweft/contracts/study-capability");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, otherWorkspaceId] = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values([
    { id: workspaceId, organizationId: teamId, name: "Study", slug: `study-${workspaceId}` },
    { id: otherWorkspaceId, organizationId: teamId, name: "Other", slug: `other-${otherWorkspaceId}` },
  ]);
});

afterEach(async () => {
  if (!schema) return;
  for (const id of [workspaceId, otherWorkspaceId]) {
    await schema.db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  }
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
  hash?: string;
}) {
  const ws = input.workspace ?? workspaceId;
  const sourceId = `src_${randomUUID()}`;
  const documentId = `doc_${randomUUID()}`;
  await schema.db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId: ws,
    title: input.title,
    contentText: (input.chunks ?? []).join("\n"),
    contentHash: input.hash ?? `hash-${sourceId}`,
    status: input.status ?? "indexed",
  });
  await schema.db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId: ws,
    sourceId,
    contentText: (input.chunks ?? []).join("\n"),
    status: "ready",
  });
  if (input.chunks?.length) {
    await schema.db.insert(schema.chunks).values(
      input.chunks.map((content, chunkNo) => ({
        id: `chk_${randomUUID()}`,
        teamId,
        workspaceId: ws,
        sourceId,
        documentId,
        chunkNo,
        content,
        headingPath: `H${chunkNo}`,
        language: "en",
      })),
    );
  }
  return { sourceId, documentId };
}

test("loads the chunks of the selected sources in selection order", async () => {
  const first = await addSource({ title: "First", chunks: ["a0", "a1"] });
  const second = await addSource({ title: "Second", chunks: ["b0"] });
  const corpus = await loader.loadStudyCorpus({
    teamId,
    workspaceId,
    sourceIds: [second.sourceId, first.sourceId],
  });
  assert.deepEqual(
    corpus.chunks.map((chunk) => chunk.text),
    ["b0", "a0", "a1"],
  );
  assert.deepEqual(
    corpus.sources.map((source) => [source.title, source.documentId]),
    [
      ["Second", second.documentId],
      ["First", first.documentId],
    ],
  );
});

test("a source outside the workspace is SOURCE_NOT_READABLE", async () => {
  const own = await addSource({ title: "Own", chunks: ["x"] });
  const foreign = await addSource({ workspace: otherWorkspaceId, title: "Foreign", chunks: ["y"] });
  await assert.rejects(
    loader.loadStudyCorpus({
      teamId,
      workspaceId,
      sourceIds: [own.sourceId, foreign.sourceId],
    }),
    (error: unknown) =>
      error instanceof engine.StudyGenerationError &&
      error.code === "SOURCE_NOT_READABLE" &&
      JSON.stringify(error.details).includes(foreign.sourceId),
  );
});

test("sources that are not indexed contribute nothing; none left is NO_INDEXED_SOURCES", async () => {
  const parsing = await addSource({ title: "Busy", status: "processing", chunks: ["p"] });
  await assert.rejects(
    loader.loadStudyCorpus({ teamId, workspaceId, sourceIds: [parsing.sourceId] }),
    (error: unknown) =>
      error instanceof engine.StudyGenerationError &&
      error.code === "NO_INDEXED_SOURCES",
  );
  const ready = await addSource({ title: "Ready", chunks: ["r"] });
  const corpus = await loader.loadStudyCorpus({
    teamId,
    workspaceId,
    sourceIds: [parsing.sourceId, ready.sourceId],
  });
  assert.deepEqual(corpus.sources.map((s) => s.sourceId), [ready.sourceId]);
});

async function addArtifact(payload: Record<string, unknown> = {}) {
  const artifactId = `art_${randomUUID()}`;
  await schema.db.insert(schema.artifacts).values({
    id: artifactId,
    teamId,
    workspaceId,
    artifactType: "quiz",
    status: "pending",
    payloadJson: payload,
  });
  return artifactId;
}

test("the checkpoint and progress live in payload_json.study and leave the rest alone", async () => {
  const artifactId = await addArtifact({ keep: "me" });
  const scope = { artifactId, teamId, workspaceId };
  const store = repository.createArtifactCheckpointStore(scope);
  assert.equal(await store.load(), null);
  const checkpoint = { versionNo: 2, groups: {}, verified: { q_1: { keep: true } } };
  await store.save(checkpoint);
  await repository.writeStudyProgress(scope, { stage: "generate", done: 1, total: 3 });
  assert.deepEqual(await store.load(), checkpoint);
  const [row] = await schema.db
    .select({ payload: schema.artifacts.payloadJson })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  assert.equal(row?.payload.keep, "me");
  assert.deepEqual((row?.payload.study as Record<string, unknown>).progress, {
    stage: "generate",
    done: 1,
    total: 3,
  });
  // Another workspace's scope cannot read it.
  const stranger = repository.createArtifactCheckpointStore({
    ...scope,
    workspaceId: otherWorkspaceId,
  });
  assert.equal(await stranger.load(), null);
});

test("input sources are recorded once per artifact and cascade with it", async () => {
  const source = await addSource({ title: "S", chunks: ["s"] });
  const artifactId = await addArtifact();
  const snapshot = {
    sourceId: source.sourceId,
    documentId: source.documentId,
    title: "S",
    contentHash: "h",
  };
  await repository.recordStudyInputSources(artifactId, [snapshot]);
  await repository.recordStudyInputSources(artifactId, [snapshot]);
  const rows = await schema.db
    .select()
    .from(schema.artifactSources)
    .where(eq(schema.artifactSources.artifactId, artifactId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, "input");

  await schema.db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
  const after = await schema.db
    .select()
    .from(schema.artifactSources)
    .where(eq(schema.artifactSources.artifactId, artifactId));
  assert.equal(after.length, 0);
});

test("freshness reads the current hashes of the workspace's sources", async () => {
  const kept = await addSource({ title: "K", chunks: ["k"], hash: "h-k" });
  const result = await freshness.loadStudyFreshness({
    teamId,
    workspaceId,
    inputs: {
      selection: "sources",
      sources: [
        { sourceId: kept.sourceId, documentId: kept.documentId, contentHash: "h-old" },
        { sourceId: "src_gone", documentId: "doc_gone", contentHash: "h" },
      ],
    },
  });
  assert.deepEqual(result, {
    state: "source_deleted",
    changedSourceIds: [kept.sourceId],
    deletedSourceIds: ["src_gone"],
  });
});
