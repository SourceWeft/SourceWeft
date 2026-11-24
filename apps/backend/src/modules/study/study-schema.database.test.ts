import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let isolated:
  | Awaited<ReturnType<typeof createIsolatedTestDatabase>>
  | undefined;
let db: typeof import("@sourceweft/db");
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const otherTeamId = randomUUID();
const workspaceId = randomUUID();
const userId = randomUUID();

async function insertArtifact(): Promise<string> {
  const id = randomUUID();
  await db.db.insert(db.artifacts).values({
    id,
    teamId,
    workspaceId,
    artifactType: "flashcards",
    status: "ready",
    currentVersionNo: 1,
    visibility: "private",
    createdBy: userId,
  });
  return id;
}

function stateRow(artifactId: string, itemId: string) {
  return {
    userId,
    teamId,
    workspaceId,
    artifactId,
    itemId,
    dueAt: new Date("2026-11-16T00:00:00Z"),
  };
}

function logRow(artifactId: string, itemId: string, grade = 3) {
  return {
    id: randomUUID(),
    userId,
    teamId,
    workspaceId,
    artifactId,
    itemId,
    versionNo: 1,
    grade,
    stateBefore: 0,
    elapsedDays: 0,
    scheduledDays: 0,
  };
}

function attemptRow(artifactId: string, overrides = {}) {
  return {
    id: randomUUID(),
    userId,
    teamId,
    workspaceId,
    artifactId,
    versionNo: 1,
    itemIds: ["q_1", "q_2"],
    total: 2,
    ...overrides,
  };
}

async function count(table: string, artifactId: string): Promise<number> {
  const result = await db.database.query(
    `select count(*)::int as n from ${table} where artifact_id = $1`,
    [artifactId],
  );
  return result.rows[0].n;
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("study_schema");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  for (const id of [teamId, otherTeamId]) {
    await db.database.query(
      'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
      [id],
    );
  }
  await db.db.insert(db.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Study",
    slug: workspaceId,
  });
});

afterAll(async () => {
  await db?.database.end();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await isolated?.close();
});

test("a new review state starts as a New card with zeroed FSRS counters", async () => {
  const artifactId = await insertArtifact();
  await db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_1"));
  const result = await db.database.query(
    "select * from study_review_states where artifact_id = $1",
    [artifactId],
  );
  const row = result.rows[0];
  assert.equal(row.state, 0);
  assert.equal(row.stability, 0);
  assert.equal(row.difficulty, 0);
  assert.equal(row.reps, 0);
  assert.equal(row.lapses, 0);
  assert.equal(row.learning_steps, 0);
  assert.equal(row.last_reviewed_at, null);
});

test("FSRS stability keeps double precision", async () => {
  const artifactId = await insertArtifact();
  const stability = 12.345678901234567;
  await db.db
    .insert(db.studyReviewStates)
    .values({ ...stateRow(artifactId, "c_1"), stability });
  const result = await db.database.query(
    "select stability from study_review_states where artifact_id = $1",
    [artifactId],
  );
  assert.equal(result.rows[0].stability, stability);
});

test("one state row per user, artifact and item", async () => {
  const artifactId = await insertArtifact();
  await db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_1"));
  await assert.rejects(
    db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_1")),
    /duplicate key|failed query/i,
  );
  await db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_2"));
  await db.db
    .insert(db.studyReviewStates)
    .values({ ...stateRow(artifactId, "c_1"), userId: randomUUID() });
});

test("states, logs and attempts reject out-of-range values", async () => {
  const artifactId = await insertArtifact();
  await assert.rejects(
    db.db
      .insert(db.studyReviewStates)
      .values({ ...stateRow(artifactId, "c_1"), state: 4 }),
    /check|failed query/i,
  );
  await assert.rejects(
    db.db.insert(db.studyReviewLogs).values(logRow(artifactId, "c_1", 5)),
    /check|failed query/i,
  );
  await assert.rejects(
    db.db.insert(db.studyReviewLogs).values(logRow(artifactId, "c_1", 0)),
    /check|failed query/i,
  );
  await assert.rejects(
    db.db
      .insert(db.studyQuizAttempts)
      .values(attemptRow(artifactId, { versionNo: 0 })),
    /check|failed query/i,
  );
  await assert.rejects(
    db.db
      .insert(db.studyQuizAttempts)
      .values(attemptRow(artifactId, { score: 3, total: 2 })),
    /check|failed query/i,
  );
});

test("the review log is append-only: every grade is kept", async () => {
  const artifactId = await insertArtifact();
  for (const grade of [1, 3, 3, 4]) {
    await db.db.insert(db.studyReviewLogs).values(logRow(artifactId, "c_1", grade));
  }
  assert.equal(await count("study_review_logs", artifactId), 4);
});

test("a quiz attempt starts unfinished with no answers", async () => {
  const artifactId = await insertArtifact();
  await db.db.insert(db.studyQuizAttempts).values(attemptRow(artifactId));
  const result = await db.database.query(
    "select answers, score, finished_at, started_at from study_quiz_attempts where artifact_id = $1",
    [artifactId],
  );
  assert.deepEqual(result.rows[0].answers, {});
  assert.equal(result.rows[0].score, null);
  assert.equal(result.rows[0].finished_at, null);
  assert.ok(result.rows[0].started_at instanceof Date);
});

test("a row must name the team that owns its workspace", async () => {
  const artifactId = await insertArtifact();
  await assert.rejects(
    db.db
      .insert(db.studyReviewStates)
      .values({ ...stateRow(artifactId, "c_1"), teamId: otherTeamId }),
    /foreign key|failed query/i,
  );
  await assert.rejects(
    db.db
      .insert(db.studyReviewLogs)
      .values({ ...logRow(artifactId, "c_1"), teamId: otherTeamId }),
    /foreign key|failed query/i,
  );
  await assert.rejects(
    db.db
      .insert(db.studyQuizAttempts)
      .values(attemptRow(artifactId, { teamId: otherTeamId })),
    /foreign key|failed query/i,
  );
});

test("deleting an artifact removes its learning state", async () => {
  const artifactId = await insertArtifact();
  await db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_1"));
  await db.db.insert(db.studyReviewLogs).values(logRow(artifactId, "c_1"));
  await db.db.insert(db.studyQuizAttempts).values(attemptRow(artifactId));
  await db.database.query("delete from artifacts where id = $1", [artifactId]);
  assert.equal(await count("study_review_states", artifactId), 0);
  assert.equal(await count("study_review_logs", artifactId), 0);
  assert.equal(await count("study_quiz_attempts", artifactId), 0);
});

test("the queue and history lookups are indexed", async () => {
  const result = await db.database.query(
    "select indexname from pg_indexes where tablename in ('study_review_states','study_review_logs','study_quiz_attempts')",
  );
  const names = result.rows.map((row: { indexname: string }) => row.indexname);
  for (const expected of [
    "study_review_states_user_due_idx",
    "study_review_logs_user_item_idx",
    "study_quiz_attempts_user_artifact_idx",
  ]) {
    assert.ok(names.includes(expected), `missing index ${expected}`);
  }
});

// Supplemental review checks (PR-1 review).

test("deleting a workspace removes its learning state", async () => {
  const otherWorkspaceId = randomUUID();
  await db.db.insert(db.workspaces).values({
    id: otherWorkspaceId,
    organizationId: teamId,
    name: "Doomed",
    slug: otherWorkspaceId,
  });
  const artifactId = randomUUID();
  await db.db.insert(db.artifacts).values({
    id: artifactId,
    teamId,
    workspaceId: otherWorkspaceId,
    artifactType: "quiz",
    status: "ready",
    currentVersionNo: 1,
    visibility: "private",
    createdBy: userId,
  });
  const scoped = { workspaceId: otherWorkspaceId };
  await db.db
    .insert(db.studyReviewStates)
    .values({ ...stateRow(artifactId, "q_1"), ...scoped });
  await db.db
    .insert(db.studyReviewLogs)
    .values({ ...logRow(artifactId, "q_1"), ...scoped });
  await db.db
    .insert(db.studyQuizAttempts)
    .values(attemptRow(artifactId, scoped));
  await db.database.query("delete from workspaces where id = $1", [
    otherWorkspaceId,
  ]);
  for (const table of [
    "study_review_states",
    "study_review_logs",
    "study_quiz_attempts",
  ]) {
    assert.equal(await count(table, artifactId), 0, table);
  }
});

test("deleting one artifact leaves another artifact's learning state alone", async () => {
  const doomed = await insertArtifact();
  const kept = await insertArtifact();
  for (const artifactId of [doomed, kept]) {
    await db.db.insert(db.studyReviewStates).values(stateRow(artifactId, "c_1"));
    await db.db.insert(db.studyReviewLogs).values(logRow(artifactId, "c_1"));
    await db.db.insert(db.studyQuizAttempts).values(attemptRow(artifactId));
  }
  await db.database.query("delete from artifacts where id = $1", [doomed]);
  assert.equal(await count("study_review_states", kept), 1);
  assert.equal(await count("study_review_logs", kept), 1);
  assert.equal(await count("study_quiz_attempts", kept), 1);
});

test("quiz answers and item ids round-trip as JSON", async () => {
  const artifactId = await insertArtifact();
  const answers = {
    q_1: { selected: [0, 2] },
    q_2: { text: "光合作用", selfGrade: "knew" },
  };
  await db.db
    .insert(db.studyQuizAttempts)
    .values(attemptRow(artifactId, { answers, score: 2, total: 2 }));
  const result = await db.database.query(
    "select item_ids, answers, score from study_quiz_attempts where artifact_id = $1",
    [artifactId],
  );
  assert.deepEqual(result.rows[0].item_ids, ["q_1", "q_2"]);
  assert.deepEqual(result.rows[0].answers, answers);
  assert.equal(result.rows[0].score, 2);
});

test("a review state cannot point at a missing artifact or workspace", async () => {
  await assert.rejects(
    db.db.insert(db.studyReviewStates).values(stateRow(randomUUID(), "c_1")),
    /foreign key|failed query/i,
  );
  const artifactId = await insertArtifact();
  await assert.rejects(
    db.db
      .insert(db.studyReviewStates)
      .values({ ...stateRow(artifactId, "c_1"), workspaceId: randomUUID() }),
    /foreign key|failed query/i,
  );
});
