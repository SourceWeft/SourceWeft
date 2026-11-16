import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * Issue #572 PR-5: per-user learning state over HTTP and against a real
 * database — FSRS grading with its log in one transaction, server-side quiz
 * scoring, finish-then-409, model-free "mistakes to cards", and the rule that
 * the workspace and team of every row come from the authorized artifact.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }));
const model = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../api/middleware/auth-session", () => ({
  getSessionUserId: () => session.userId,
  requireSession: async () =>
    session.userId
      ? {
          user: { id: session.userId },
          session: { id: `s_${session.userId}`, userId: session.userId },
        }
      : null,
}));
vi.mock("../../../shared/model-gateway/default-chat-structured", () => ({
  completeStructuredWithDefaultChat: async () => {
    model.calls += 1;
    throw new Error("learning state must never call a model");
  },
}));

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let review: typeof import("./review-service");
let fsrs: Awaited<ReturnType<typeof import("../capability").loadStudyScheduling>>;
let app: Hono;
const originalDatabaseUrl = process.env.DATABASE_URL;

const teamId = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const learner = "learner";
const peer = "peer";
const outsider = "outsider";
let threadId: string;
let peerPrivateThreadId: string;

const evidence = {
  kind: "chunk",
  sourceId: "src_1",
  documentId: "doc_1",
  chunkId: "chunk_1",
  quote: "Jupiter is the largest planet.",
  quoteHash: `sha256:${"a".repeat(64)}`,
};
const base = {
  schemaVersion: 1,
  language: "en",
  inputs: {
    selection: "sources",
    sources: [{ sourceId: "src_1", documentId: "doc_1", contentHash: "h" }],
  },
  generation: {
    promptVersion: "test.v1",
    modelAlias: "chat-default",
    mode: "single",
    stats: { requested: 3, kept: 3, dropped: {}, groups: 1, tokensEstimated: 10 },
    recipe: { options: {}, sourceIds: ["src_1"] },
  },
};
const card = (id: string) => ({
  id,
  fingerprint: "0123456789abcdef",
  front: `Front ${id}`,
  back: `Back ${id}`,
  tags: [],
  difficulty: 1,
  evidence: [evidence],
});
const deck = (ids: string[]) => ({ ...base, kind: "flashcards", items: ids.map(card) });
const quiz = {
  ...base,
  kind: "quiz",
  items: [
    {
      id: "q_single",
      fingerprint: "0000000000000001",
      type: "single",
      stem: "Largest planet?",
      options: ["Mars", "Jupiter"],
      correct: [1],
      explanation: "Jupiter.",
      difficulty: 1,
      evidence: [evidence],
    },
    {
      id: "q_multi",
      fingerprint: "0000000000000002",
      type: "multi",
      stem: "Gas giants?",
      options: ["Jupiter", "Earth", "Saturn"],
      correct: [0, 2],
      explanation: "Jupiter and Saturn.",
      difficulty: 2,
      evidence: [evidence],
    },
    {
      id: "q_tf",
      fingerprint: "0000000000000003",
      type: "truefalse",
      stem: "Pluto is a planet.",
      options: ["true", "false"],
      correct: [1],
      explanation: "Pluto is a dwarf planet.",
      difficulty: 2,
      evidence: [evidence],
    },
    {
      id: "q_short",
      fingerprint: "0000000000000004",
      type: "short",
      stem: "Why is the sky blue?",
      referenceAnswer: "Rayleigh scattering.",
      explanation: "Short wavelengths scatter more.",
      difficulty: 3,
      evidence: [evidence],
    },
  ],
};

async function createArtifact(input: {
  artifactType: "flashcards" | "quiz" | "mindmap";
  payload: Record<string, unknown>;
  thread?: string;
  userId?: string;
  title?: string;
}) {
  const artifactId = randomUUID();
  const { createReadyArtifactRecord } = await import("../../artifacts/repository");
  await createReadyArtifactRecord({
    artifactId,
    artifactType: input.artifactType,
    teamId,
    workspaceId,
    threadId: input.thread ?? threadId,
    userId: input.userId ?? learner,
    title: input.title ?? "Planets",
    prompt: "test",
    payload: input.payload,
  });
  return artifactId;
}

/** Appends a new current version to an artifact, as a regeneration would. */
async function addVersion(artifactId: string, payload: Record<string, unknown>) {
  const { eq } = await import("drizzle-orm");
  const [row] = await schema.db
    .select({ n: schema.artifacts.currentVersionNo })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  const versionNo = row!.n + 1;
  await schema.db.insert(schema.artifactVersions).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    artifactId,
    versionNo,
    contentJson: payload,
    createdBy: learner,
  });
  await schema.db
    .update(schema.artifacts)
    .set({ currentVersionNo: versionNo, payloadJson: payload })
    .where(eq(schema.artifacts.id, artifactId));
  return versionNo;
}

function call(
  method: string,
  path: string,
  body?: unknown,
  options: { as?: string | null; workspace?: string } = {},
) {
  session.userId = options.as === undefined ? learner : options.as;
  return app.request(`/v1/workspaces/${options.workspace ?? workspaceId}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function data(response: Response) {
  // Bodies are read loosely here; their shapes are what the assertions check.
  const json = JSON.parse(await response.text());
  return json.data ?? json;
}

async function rows(sqlText: string, params: unknown[]) {
  return (await schema.database.query(sqlText, params)).rows;
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("study_state");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  review = await import("./review-service");
  fsrs = await (await import("../capability")).loadStudyScheduling();
  const { createWorkspaceRouteTestApp } = await import("../../../test/hono");
  const { registerStudyStateRoutes } = await import(
    "../../../api/routes/content/study-state"
  );
  app = createWorkspaceRouteTestApp(registerStudyStateRoutes);

  await schema.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values([
    { id: workspaceId, organizationId: teamId, name: "Study", slug: workspaceId },
    {
      id: otherWorkspaceId,
      organizationId: teamId,
      name: "Other",
      slug: otherWorkspaceId,
    },
  ]);
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: learner, role: "editor", source: "guest" },
    { workspaceId, userId: peer, role: "editor", source: "guest" },
    { workspaceId: otherWorkspaceId, userId: learner, role: "editor", source: "guest" },
  ]);
  threadId = randomUUID();
  peerPrivateThreadId = randomUUID();
  await schema.db.insert(schema.threads).values([
    {
      id: threadId,
      teamId,
      workspaceId,
      title: "Study",
      visibility: "workspace",
      createdBy: learner,
    },
    {
      id: peerPrivateThreadId,
      teamId,
      workspaceId,
      title: "Peer private",
      visibility: "private",
      createdBy: peer,
    },
  ]);
}, 120_000);

beforeEach(() => {
  model.calls = 0;
});

afterAll(async () => {
  await schema?.database.end();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await isolated?.close();
});

/* Review ------------------------------------------------------------------ */

test("grading moves due forward and appends exactly one matching log per grade", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1", "c_2"]),
  });
  const first = await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_1",
    grade: 3,
  });
  assert.equal(first.status, 200);
  const one = await data(first);
  assert.equal(one.itemId, "c_1");
  assert.equal(one.reps, 1);
  assert.equal(one.state, 1);
  assert.ok(new Date(one.dueAt) > new Date(one.lastReviewedAt));

  const second = await data(
    await call("POST", `/study/artifacts/${artifactId}/review`, {
      versionNo: 1,
      itemId: "c_1",
      grade: 1,
    }),
  );
  assert.equal(second.reps, 2);

  const logs = await rows(
    "select * from study_review_logs where artifact_id = $1 order by reviewed_at, state_before",
    [artifactId],
  );
  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => [log.grade, log.state_before, log.version_no, log.user_id]),
    [
      [3, 0, 1, learner],
      [1, one.state, 1, learner],
    ],
  );
  assert.equal(logs[1].due_before.toISOString(), one.dueAt);
  assert.equal(logs[1].stability_before, one.stability);
});

test("a failed log append rolls the state change back", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1", "c_boom"]),
  });
  await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_boom",
    grade: 3,
  });
  const before = await rows(
    "select * from study_review_states where artifact_id = $1",
    [artifactId],
  );
  await schema.database.query(`
    create or replace function study_test_fail_log() returns trigger as $$
    begin
      if new.item_id = 'c_boom' then raise exception 'log append failed'; end if;
      return new;
    end $$ language plpgsql;
    create trigger study_test_fail_log before insert on study_review_logs
      for each row execute function study_test_fail_log();
  `);
  try {
    const response = await call("POST", `/study/artifacts/${artifactId}/review`, {
      versionNo: 1,
      itemId: "c_boom",
      grade: 4,
    });
    assert.equal(response.status, 500);
  } finally {
    await schema.database.query(
      "drop trigger study_test_fail_log on study_review_logs; drop function study_test_fail_log();",
    );
  }
  const after = await rows(
    "select * from study_review_states where artifact_id = $1",
    [artifactId],
  );
  assert.deepEqual(after, before, "state is unchanged without its log");
  assert.equal(
    (await rows("select * from study_review_logs where artifact_id = $1", [artifactId]))
      .length,
    1,
  );
});

test("two devices grading the same card at once equal grading in sequence", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  const now = new Date("2026-11-15T10:00:00.000Z");
  const grade = () =>
    review.gradeFlashcard(
      { workspaceId, userId: learner, artifactId, versionNo: 1, itemId: "c_1", grade: 3 },
      { now: () => now },
    );
  // Both the first grade (no row yet) and later grades (row exists) race.
  await Promise.all([grade(), grade()]);
  await Promise.all([grade(), grade(), grade(), grade()]);

  let expected = fsrs.scheduleReview(null, 3, now).state;
  const sequence = [expected];
  for (let i = 1; i < 6; i += 1) {
    expected = fsrs.scheduleReview(expected, 3, now).state;
    sequence.push(expected);
  }
  const [state] = await rows(
    "select * from study_review_states where artifact_id = $1",
    [artifactId],
  );
  assert.equal(state.reps, 6);
  assert.equal(state.state, expected.state);
  assert.equal(state.stability, expected.stability);
  assert.equal(state.difficulty, expected.difficulty);
  assert.equal(state.due_at.toISOString(), expected.dueAt.toISOString());
  const logs = await rows(
    "select stability_before from study_review_logs where artifact_id = $1",
    [artifactId],
  );
  assert.deepEqual(
    logs.map((log) => log.stability_before).sort((a, b) => a - b),
    [0, ...sequence.slice(0, 5).map((card) => card.stability)].sort((a, b) => a - b),
    "every log starts from the state the previous grade left",
  );
});

test("an item outside the version is a 400 and leaves no state", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  const response = await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_forged",
    grade: 3,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "STUDY_ITEM_NOT_IN_VERSION");
  assert.equal(
    (await rows("select * from study_review_states where artifact_id = $1", [artifactId]))
      .length,
    0,
  );
  const unknownVersion = await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 2,
    itemId: "c_1",
    grade: 3,
  });
  assert.equal(unknownVersion.status, 404);
  const badGrade = await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_1",
    grade: 5,
  });
  assert.equal(badGrade.status, 400);
});

test("workspace and team on every row come from the artifact, not the request", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  // The learner belongs to the other workspace too, but the artifact is not
  // in it: naming that workspace in the route finds nothing.
  const mismatched = await call(
    "POST",
    `/study/artifacts/${artifactId}/review`,
    { versionNo: 1, itemId: "c_1", grade: 3 },
    { workspace: otherWorkspaceId },
  );
  assert.equal(mismatched.status, 404);
  // Body fields naming another workspace or team are ignored.
  const ok = await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_1",
    grade: 3,
    workspaceId: otherWorkspaceId,
    teamId: "forged-team",
  });
  assert.equal(ok.status, 200);
  for (const table of ["study_review_states", "study_review_logs"]) {
    const found = await rows(
      `select workspace_id, team_id from ${table} where artifact_id = $1`,
      [artifactId],
    );
    assert.deepEqual(found, [{ workspace_id: workspaceId, team_id: teamId }]);
  }
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const wrongPlace = await call(
    "POST",
    `/study/artifacts/${quizId}/quiz/attempts`,
    { versionNo: 1 },
    { workspace: otherWorkspaceId },
  );
  assert.equal(wrongPlace.status, 404);
  const attempt = await data(
    await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
      versionNo: 1,
      workspaceId: otherWorkspaceId,
    }),
  );
  assert.deepEqual(
    await rows("select workspace_id, team_id from study_quiz_attempts where id = $1", [
      attempt.id,
    ]),
    [{ workspace_id: workspaceId, team_id: teamId }],
  );
  // An attempt is reachable only through the workspace it belongs to.
  const elsewhere = await call(
    "PUT",
    `/study/quiz/attempts/${attempt.id}`,
    { answers: {} },
    { workspace: otherWorkspaceId },
  );
  assert.equal(elsewhere.status, 404);
});

test("progress returns only the caller's state for the version's items", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1", "c_2"]),
  });
  await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_1",
    grade: 3,
  });
  await call(
    "POST",
    `/study/artifacts/${artifactId}/review`,
    { versionNo: 1, itemId: "c_2", grade: 3 },
    { as: peer },
  );
  const progress = await data(
    await call("GET", `/study/artifacts/${artifactId}/progress?versionNo=1`),
  );
  assert.equal(progress.versionNo, 1);
  assert.deepEqual(Object.keys(progress.items), ["c_1"]);
  assert.equal(progress.items.c_1.reps, 1);
});

test("the queue is the caller's due cards, oldest first, current items only, capped", async () => {
  const deckA = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_a1", "c_a2", "c_a3"]),
  });
  const deckB = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_b1"]),
  });
  // Seed due states directly so due order is controlled.
  const due = (artifactId: string, itemId: string, iso: string, userId = learner) =>
    schema.db.insert(schema.studyReviewStates).values({
      userId,
      teamId,
      workspaceId,
      artifactId,
      itemId,
      state: 2,
      dueAt: new Date(iso),
      reps: 1,
      lastReviewedAt: new Date("2026-01-01T00:00:00Z"),
    });
  await due(deckA, "c_a2", "2026-02-03T00:00:00Z");
  await due(deckA, "c_a1", "2026-02-01T00:00:00Z");
  await due(deckB, "c_b1", "2026-02-02T00:00:00Z");
  await due(deckA, "c_a3", "2999-01-01T00:00:00Z"); // not due yet
  await due(deckB, "c_b1", "2026-01-15T00:00:00Z", peer); // someone else's

  const narrowed = await data(
    await call("GET", `/study/review/queue?artifactId=${deckA}`),
  );
  assert.deepEqual(
    narrowed.items.map((item: { itemId: string }) => item.itemId),
    ["c_a1", "c_a2"],
  );

  // A regeneration drops c_a1: its state stays, but it leaves the queue, and
  // the new card c_a4 is offered as new.
  await addVersion(deckA, deck(["c_a2", "c_a3", "c_a4"]));
  const after = await data(await call("GET", `/study/review/queue?artifactId=${deckA}`));
  assert.deepEqual(
    after.items.map((item: { itemId: string; state: number; versionNo: number }) => [
      item.itemId,
      item.state,
      item.versionNo,
    ]),
    [
      ["c_a2", 2, 2],
      ["c_a4", 0, 2],
    ],
  );

  const all = await data(await call("GET", "/study/review/queue?limit=2"));
  assert.deepEqual(
    all.items.map((item: { itemId: string }) => item.itemId),
    ["c_b1", "c_a2"],
  );
  assert.equal((await call("GET", "/study/review/queue?limit=51")).status, 400);
  const many = await createArtifact({
    artifactType: "flashcards",
    payload: deck(Array.from({ length: 60 }, (_, i) => `c_m${i}`)),
  });
  const capped = await data(await call("GET", `/study/review/queue?artifactId=${many}`));
  assert.equal(capped.items.length, 50);
});

test("clients may name the version by the artifactVersionId they hold", async () => {
  const deckId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const versionIdOf = async (artifactId: string) =>
    (
      await rows("select id from artifact_versions where artifact_id = $1", [artifactId])
    )[0].id as string;
  const deckVersionId = await versionIdOf(deckId);
  const quizVersionId = await versionIdOf(quizId);

  const graded = await call("POST", `/study/artifacts/${deckId}/review`, {
    artifactVersionId: deckVersionId,
    itemId: "c_1",
    grade: 3,
  });
  assert.equal(graded.status, 200);
  const [log] = await rows("select version_no from study_review_logs where artifact_id = $1", [
    deckId,
  ]);
  assert.equal(log.version_no, 1, "the id resolves to the stored version number");

  const progress = await data(
    await call("GET", `/study/artifacts/${deckId}/progress?artifactVersionId=${deckVersionId}`),
  );
  assert.equal(progress.artifactVersionId, deckVersionId);
  assert.equal(progress.versionNo, 1);
  assert.equal(progress.items.c_1.reps, 1);

  const started = await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
    artifactVersionId: quizVersionId,
  });
  assert.equal(started.status, 201);
  assert.equal((await data(started)).versionNo, 1);

  // Another artifact's version id is not this artifact's version.
  assert.equal(
    (
      await call("POST", `/study/artifacts/${deckId}/review`, {
        artifactVersionId: quizVersionId,
        itemId: "c_1",
        grade: 3,
      })
    ).status,
    404,
  );
  for (const body of [
    { itemId: "c_1", grade: 3 },
    { versionNo: 1, artifactVersionId: deckVersionId, itemId: "c_1", grade: 3 },
  ]) {
    assert.equal(
      (await call("POST", `/study/artifacts/${deckId}/review`, body)).status,
      400,
      "exactly one version reference",
    );
  }
});

/* Quiz -------------------------------------------------------------------- */

test("quiz answers are scored on the server; finishing locks the attempt", async () => {
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const started = await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
    versionNo: 1,
  });
  assert.equal(started.status, 201);
  const attempt = await data(started);
  assert.equal(attempt.total, 3, "the short question is self-graded, outside the auto score");
  assert.equal(attempt.score, null);
  assert.equal(attempt.results, null);

  const draft = await data(
    await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
      answers: { q_single: { selected: [1] }, q_multi: { selected: [0] } },
    }),
  );
  assert.equal(draft.finishedAt, null);
  assert.equal(draft.score, null);

  const finished = await data(
    await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
      // Later answers replace earlier ones per question.
      answers: { q_multi: { selected: [2, 0] }, q_short: { selfGrade: "missed" } },
      finish: true,
    }),
  );
  assert.equal(finished.score, 2);
  assert.deepEqual(finished.results, {
    q_single: "correct",
    q_multi: "correct",
    q_tf: "unanswered",
    q_short: "incorrect",
  });
  assert.ok(finished.finishedAt);

  const again = await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
    answers: { q_tf: { selected: [1] } },
  });
  assert.equal(again.status, 409);

  const history = await data(await call("GET", `/study/artifacts/${quizId}/quiz/attempts`));
  assert.deepEqual(
    history.items.map((item: { id: string; score: number }) => [item.id, item.score]),
    [[attempt.id, 2]],
  );
  assert.equal(
    (await data(await call("GET", `/study/artifacts/${quizId}/quiz/attempts`, undefined, { as: peer })))
      .items.length,
    0,
    "attempts are private to their learner",
  );
});

test("multi scores only when every correct option is chosen; short self grades count", async () => {
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const attempt = await data(
    await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, { versionNo: 1 }),
  );
  const finished = await data(
    await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
      answers: {
        q_single: { selected: [0] },
        q_multi: { selected: [0, 1, 2] },
        q_tf: { selected: [1] },
        q_short: { selfGrade: "knew", text: "scattering" },
      },
      finish: true,
    }),
  );
  assert.deepEqual(finished.results, {
    q_single: "incorrect",
    q_multi: "incorrect",
    q_tf: "correct",
    q_short: "correct",
  });
  assert.equal(finished.score, 1, "a short question known by self grade is not auto score");
});

test("invalid answers and attempts are rejected", async () => {
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const subset = await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
    versionNo: 1,
    itemIds: ["q_multi"],
  });
  const attempt = await data(subset);
  assert.equal(attempt.total, 1);
  for (const answers of [
    { q_single: { selected: [1] } }, // not in this attempt
    { q_multi: { selected: [7] } }, // option out of range
    { q_multi: { selfGrade: "knew" } }, // self grade on a choice question
  ]) {
    const response = await call("PUT", `/study/quiz/attempts/${attempt.id}`, { answers });
    assert.equal(response.status, 400, JSON.stringify(answers));
  }
  for (const body of [
    { versionNo: 1, itemIds: ["q_nope"] },
    { versionNo: 1, itemIds: ["q_tf", "q_tf"] },
  ]) {
    assert.equal(
      (await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, body)).status,
      400,
    );
  }
  const single = await data(
    await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
      versionNo: 1,
      itemIds: ["q_single"],
    }),
  );
  assert.equal(
    (
      await call("PUT", `/study/quiz/attempts/${single.id}`, {
        answers: { q_single: { selected: [0, 1] } },
      })
    ).status,
    400,
    "a single-choice question takes one option",
  );
  assert.equal(
    (await call("PUT", `/study/quiz/attempts/${single.id}`, { answers: {} }, { as: peer }))
      .status,
    404,
    "another learner's attempt does not exist for them",
  );
});

/* Mistakes to cards ------------------------------------------------------- */

test("missed questions become a flashcards artifact with no model call and no ledger", async () => {
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz, title: "Planets quiz" });
  await schema.db.insert(schema.sources).values({
    id: "src_1",
    teamId,
    workspaceId,
    title: "Planets",
    status: "indexed",
  }).onConflictDoNothing();
  await schema.db.insert(schema.artifactSources).values({
    id: randomUUID(),
    artifactId: quizId,
    sourceId: "src_1",
    role: "input",
  });
  const attempt = await data(
    await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, { versionNo: 1 }),
  );

  const early = await call("POST", `/study/quiz/attempts/${attempt.id}/derive-cards`);
  assert.equal(early.status, 409, "an unfinished attempt cannot be turned into cards");

  await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
    answers: {
      q_single: { selected: [1] },
      q_multi: { selected: [0] },
      q_short: { selfGrade: "missed" },
    },
    finish: true,
  });
  const ledgerBefore = await rows("select count(*)::int as n from usage_ledgers", []);

  const derived = await call("POST", `/study/quiz/attempts/${attempt.id}/derive-cards`);
  assert.equal(derived.status, 201);
  const result = await data(derived);
  assert.equal(result.itemCount, 3);
  assert.equal(result.reused, false);

  const [artifact] = await rows(
    "select artifact_type, thread_id, visibility, created_by, workspace_id, team_id from artifacts where id = $1",
    [result.artifactId],
  );
  assert.deepEqual(artifact, {
    artifact_type: "flashcards",
    thread_id: threadId,
    visibility: "workspace",
    created_by: learner,
    workspace_id: workspaceId,
    team_id: teamId,
  });
  const [version] = await rows(
    "select content_json from artifact_versions where artifact_id = $1",
    [result.artifactId],
  );
  const fronts = version.content_json.items.map((item: { front: string }) => item.front);
  assert.deepEqual(fronts, ["Gas giants?", "Pluto is a planet.", "Why is the sky blue?"]);
  for (const item of version.content_json.items) {
    assert.deepEqual(item.evidence, [evidence]);
  }
  assert.deepEqual(
    await rows("select source_id, role from artifact_sources where artifact_id = $1", [
      result.artifactId,
    ]),
    [{ source_id: "src_1", role: "input" }],
  );

  // A retry returns the same deck and does not duplicate source links.
  const retry = await call("POST", `/study/quiz/attempts/${attempt.id}/derive-cards`);
  assert.equal(retry.status, 200);
  assert.equal((await data(retry)).artifactId, result.artifactId);
  assert.equal(
    (await rows("select * from artifact_sources where artifact_id = $1", [result.artifactId]))
      .length,
    1,
  );

  assert.equal(model.calls, 0);
  assert.deepEqual(
    await rows("select count(*)::int as n from usage_ledgers", []),
    ledgerBefore,
  );
});

test("a perfect attempt has no mistakes to derive", async () => {
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  const attempt = await data(
    await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, {
      versionNo: 1,
      itemIds: ["q_tf"],
    }),
  );
  await call("PUT", `/study/quiz/attempts/${attempt.id}`, {
    answers: { q_tf: { selected: [1] } },
    finish: true,
  });
  const response = await call("POST", `/study/quiz/attempts/${attempt.id}/derive-cards`);
  assert.equal(response.status, 400);
});

/* Access ------------------------------------------------------------------ */

test("without a session every route is 401", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  const requests: [string, string, unknown?][] = [
    ["GET", "/study/review/queue"],
    ["GET", `/study/artifacts/${artifactId}/progress`],
    ["POST", `/study/artifacts/${artifactId}/review`, { versionNo: 1, itemId: "c_1", grade: 3 }],
    ["POST", `/study/artifacts/${artifactId}/quiz/attempts`, { versionNo: 1 }],
    ["GET", `/study/artifacts/${artifactId}/quiz/attempts`],
    ["PUT", "/study/quiz/attempts/any", { answers: {} }],
    ["POST", "/study/quiz/attempts/any/derive-cards"],
  ];
  for (const [method, path, body] of requests) {
    const response = await call(method, path, body, { as: null });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("outsiders, private artifacts of others and wrong types are all 404", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  const grade = { versionNo: 1, itemId: "c_1", grade: 3 };
  assert.equal(
    (await call("POST", `/study/artifacts/${artifactId}/review`, grade, { as: outsider }))
      .status,
    404,
  );
  assert.equal(
    (await call("GET", "/study/review/queue", undefined, { as: outsider })).status,
    404,
  );
  const peerPrivate = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
    thread: peerPrivateThreadId,
    userId: peer,
  });
  assert.equal(
    (await call("POST", `/study/artifacts/${peerPrivate}/review`, grade)).status,
    404,
  );
  assert.equal(
    (await call("POST", `/study/artifacts/${peerPrivate}/review`, grade, { as: peer })).status,
    200,
  );
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  assert.equal(
    (await call("POST", `/study/artifacts/${quizId}/review`, { ...grade, itemId: "q_single" }))
      .status,
    404,
    "a quiz has no flashcard review",
  );
  assert.equal(
    (await call("POST", `/study/artifacts/${artifactId}/quiz/attempts`, { versionNo: 1 }))
      .status,
    404,
  );
  assert.equal(
    (await call("GET", `/study/artifacts/${randomUUID()}/progress`)).status,
    404,
  );
});

test("deleting the artifact removes its learning state", async () => {
  const artifactId = await createArtifact({
    artifactType: "flashcards",
    payload: deck(["c_1"]),
  });
  await call("POST", `/study/artifacts/${artifactId}/review`, {
    versionNo: 1,
    itemId: "c_1",
    grade: 3,
  });
  const quizId = await createArtifact({ artifactType: "quiz", payload: quiz });
  await call("POST", `/study/artifacts/${quizId}/quiz/attempts`, { versionNo: 1 });
  await schema.database.query("delete from artifacts where id = any($1)", [
    [artifactId, quizId],
  ]);
  for (const table of ["study_review_states", "study_review_logs", "study_quiz_attempts"]) {
    expect(
      await rows(`select 1 from ${table} where artifact_id = any($1)`, [[artifactId, quizId]]),
    ).toEqual([]);
  }
});
