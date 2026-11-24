import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  artifactSources,
  artifactVersions,
  artifacts,
  db,
  studyQuizAttempts,
  studyReviewLogs,
  studyReviewStates,
} from "@sourceweft/db";
import { visibleContentWhere } from "../../workspace/content-visibility";
import type {
  StudyReviewCard as ReviewCard,
  StudyReviewLogEntry as ReviewLogEntry,
} from "@sourceweft/contracts/study-capability";

/**
 * Persistence for per-user learning state. Every write takes `teamId` and
 * `workspaceId` from the artifact row the caller was authorized against, never
 * from request input: the database cannot check that a learning row's
 * workspace matches its artifact's (artifacts have no (id, workspace_id) key).
 */

export type StudyOwner = {
  userId: string;
  teamId: string;
  workspaceId: string;
  artifactId: string;
};

export type ReviewStateRow = typeof studyReviewStates.$inferSelect;
export type QuizAttemptRow = typeof studyQuizAttempts.$inferSelect;

/** One ready artifact version, scoped to its workspace and tenant. */
export async function findReadyStudyArtifactVersion(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
  /** Omitted (with `artifactVersionId`) means the current version. */
  versionNo?: number;
  /** The version's row id, as clients hold it; alternative to `versionNo`. */
  artifactVersionId?: string;
}) {
  const versionMatch =
    input.artifactVersionId !== undefined
      ? eq(artifactVersions.id, input.artifactVersionId)
      : input.versionNo === undefined
        ? eq(artifactVersions.versionNo, artifacts.currentVersionNo)
        : eq(artifactVersions.versionNo, input.versionNo);
  const [row] = await db
    .select({
      artifactId: artifacts.id,
      teamId: artifacts.teamId,
      workspaceId: artifacts.workspaceId,
      threadId: artifacts.threadId,
      artifactType: artifacts.artifactType,
      title: artifacts.title,
      visibility: artifacts.visibility,
      createdBy: artifacts.createdBy,
      currentVersionNo: artifacts.currentVersionNo,
      versionId: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      contentJson: artifactVersions.contentJson,
    })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.teamId, artifacts.teamId),
        eq(artifactVersions.workspaceId, artifacts.workspaceId),
        versionMatch,
      ),
    )
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.status, "ready"),
        gt(artifacts.currentVersionNo, 0),
        lte(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .limit(1);
  return row ?? null;
}

function cardOf(row: ReviewStateRow): ReviewCard {
  return {
    state: row.state as ReviewCard["state"],
    dueAt: row.dueAt,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    lastReviewedAt: row.lastReviewedAt,
  };
}

/**
 * Grades one item in one transaction: lock (creating a New row if this is the
 * first grade), compute, update the state and append the log. Two devices
 * grading the same card serialize on the row lock, so the result equals
 * applying the grades one after the other.
 */
export async function gradeReviewItem(input: {
  owner: StudyOwner;
  itemId: string;
  versionNo: number;
  now: Date;
  schedule: (card: ReviewCard | null, now: Date) => {
    state: ReviewCard;
    log: ReviewLogEntry;
  };
}): Promise<ReviewStateRow> {
  const { owner, itemId } = input;
  return db.transaction(async (tx) => {
    await tx
      .insert(studyReviewStates)
      .values({
        userId: owner.userId,
        teamId: owner.teamId,
        workspaceId: owner.workspaceId,
        artifactId: owner.artifactId,
        itemId,
        dueAt: input.now,
      })
      .onConflictDoNothing();
    const [locked] = await tx
      .select()
      .from(studyReviewStates)
      .where(
        and(
          eq(studyReviewStates.userId, owner.userId),
          eq(studyReviewStates.artifactId, owner.artifactId),
          eq(studyReviewStates.itemId, itemId),
        ),
      )
      .for("update");
    if (!locked) throw new Error("Review state row vanished under lock");

    // A grade never lands before the previous one, even across clock skew.
    const now =
      locked.lastReviewedAt && locked.lastReviewedAt > input.now
        ? locked.lastReviewedAt
        : input.now;
    const { state, log } = input.schedule(
      locked.reps === 0 && locked.state === 0 ? null : cardOf(locked),
      now,
    );

    const [updated] = await tx
      .update(studyReviewStates)
      .set({
        state: state.state,
        dueAt: state.dueAt,
        stability: state.stability,
        difficulty: state.difficulty,
        elapsedDays: state.elapsedDays,
        scheduledDays: state.scheduledDays,
        learningSteps: state.learningSteps,
        reps: state.reps,
        lapses: state.lapses,
        lastReviewedAt: state.lastReviewedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(studyReviewStates.userId, owner.userId),
          eq(studyReviewStates.artifactId, owner.artifactId),
          eq(studyReviewStates.itemId, itemId),
        ),
      )
      .returning();
    await tx.insert(studyReviewLogs).values({
      id: randomUUID(),
      userId: owner.userId,
      teamId: owner.teamId,
      workspaceId: owner.workspaceId,
      artifactId: owner.artifactId,
      itemId,
      versionNo: input.versionNo,
      grade: log.grade,
      stateBefore: log.stateBefore,
      dueBefore: log.dueBefore,
      stabilityBefore: log.stabilityBefore,
      difficultyBefore: log.difficultyBefore,
      elapsedDays: log.elapsedDays,
      scheduledDays: log.scheduledDays,
      reviewedAt: log.reviewedAt,
    });
    return updated!;
  });
}

export async function listReviewStates(input: {
  userId: string;
  artifactId: string;
  itemIds: readonly string[];
}): Promise<ReviewStateRow[]> {
  if (input.itemIds.length === 0) return [];
  return db
    .select()
    .from(studyReviewStates)
    .where(
      and(
        eq(studyReviewStates.userId, input.userId),
        eq(studyReviewStates.artifactId, input.artifactId),
        inArray(studyReviewStates.itemId, [...input.itemIds]),
      ),
    );
}

/**
 * Due cards of the user in one workspace, oldest due first. Only items still
 * present in the artifact's current version count; a card dropped by a
 * regeneration keeps its state but leaves the queue.
 */
export async function listDueReviewItems(input: {
  userId: string;
  workspaceId: string;
  artifactId?: string;
  now: Date;
  limit: number;
}) {
  const conditions = [
    eq(studyReviewStates.userId, input.userId),
    eq(studyReviewStates.workspaceId, input.workspaceId),
    lte(studyReviewStates.dueAt, input.now),
    gt(studyReviewStates.reps, 0),
    eq(artifacts.status, "ready"),
    eq(artifacts.artifactType, "flashcards"),
    visibleContentWhere(
      { userId: input.userId },
      { visibility: artifacts.visibility, createdBy: artifacts.createdBy },
    ),
    sql`exists (select 1 from jsonb_array_elements(${artifactVersions.contentJson}->'items') as item where item->>'id' = ${studyReviewStates.itemId})`,
  ];
  if (input.artifactId) {
    conditions.push(eq(studyReviewStates.artifactId, input.artifactId));
  }
  return db
    .select({
      artifactId: studyReviewStates.artifactId,
      versionNo: artifactVersions.versionNo,
      itemId: studyReviewStates.itemId,
      state: studyReviewStates.state,
      dueAt: studyReviewStates.dueAt,
    })
    .from(studyReviewStates)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, studyReviewStates.artifactId),
        eq(artifacts.workspaceId, studyReviewStates.workspaceId),
        eq(artifacts.teamId, studyReviewStates.teamId),
      ),
    )
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(studyReviewStates.dueAt), asc(studyReviewStates.itemId))
    .limit(input.limit);
}

/**
 * Flashcard decks of the user in one workspace that new cards may come from:
 * the named one, or every deck the user has graded at least once, most
 * recently studied first.
 */
export async function listStudiedDeckIds(input: {
  userId: string;
  workspaceId: string;
  limit: number;
}): Promise<string[]> {
  const rows = await db
    .select({
      artifactId: studyReviewStates.artifactId,
      lastReviewedAt: sql<Date>`max(${studyReviewStates.lastReviewedAt})`,
    })
    .from(studyReviewStates)
    .where(
      and(
        eq(studyReviewStates.userId, input.userId),
        eq(studyReviewStates.workspaceId, input.workspaceId),
      ),
    )
    .groupBy(studyReviewStates.artifactId)
    .orderBy(desc(sql`max(${studyReviewStates.lastReviewedAt})`))
    .limit(input.limit);
  return rows.map((row) => row.artifactId);
}

export async function insertQuizAttempt(input: {
  owner: StudyOwner;
  versionNo: number;
  itemIds: string[];
  /** Auto-scored (choice) questions among `itemIds`. */
  total: number;
}): Promise<QuizAttemptRow> {
  const [row] = await db
    .insert(studyQuizAttempts)
    .values({
      id: randomUUID(),
      userId: input.owner.userId,
      teamId: input.owner.teamId,
      workspaceId: input.owner.workspaceId,
      artifactId: input.owner.artifactId,
      versionNo: input.versionNo,
      itemIds: input.itemIds,
      total: input.total,
    })
    .returning();
  return row!;
}

/** The caller's own attempt; another user's attempt does not exist for them. */
export async function findOwnQuizAttempt(input: {
  userId: string;
  attemptId: string;
}): Promise<QuizAttemptRow | null> {
  const [row] = await db
    .select()
    .from(studyQuizAttempts)
    .where(
      and(
        eq(studyQuizAttempts.id, input.attemptId),
        eq(studyQuizAttempts.userId, input.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Saves answers on an unfinished attempt, optionally finishing it with its
 * score. Returns null when the attempt was already finished, so two finishes
 * racing each other cannot both win.
 */
export async function saveQuizAttempt(input: {
  userId: string;
  attemptId: string;
  answers: Record<string, unknown>;
  finish: { score: number; finishedAt: Date } | null;
}): Promise<QuizAttemptRow | null> {
  const [row] = await db
    .update(studyQuizAttempts)
    .set({
      answers: input.answers,
      ...(input.finish
        ? { score: input.finish.score, finishedAt: input.finish.finishedAt }
        : {}),
    })
    .where(
      and(
        eq(studyQuizAttempts.id, input.attemptId),
        eq(studyQuizAttempts.userId, input.userId),
        isNull(studyQuizAttempts.finishedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listOwnQuizAttempts(input: {
  userId: string;
  artifactId: string;
  limit: number;
  /** Only the attempts at this version. */
  versionNo?: number;
}): Promise<QuizAttemptRow[]> {
  return db
    .select()
    .from(studyQuizAttempts)
    .where(
      and(
        eq(studyQuizAttempts.userId, input.userId),
        eq(studyQuizAttempts.artifactId, input.artifactId),
        input.versionNo === undefined
          ? undefined
          : eq(studyQuizAttempts.versionNo, input.versionNo),
      ),
    )
    .orderBy(desc(studyQuizAttempts.startedAt), desc(studyQuizAttempts.id))
    .limit(input.limit);
}

/**
 * Records the derived deck's input sources, copying the quiz's own source
 * links. Idempotent, so a retried derive does not duplicate them.
 */
export async function copyInputSources(input: {
  fromArtifactId: string;
  toArtifactId: string;
}): Promise<void> {
  await db.execute(sql`
    insert into ${artifactSources} (id, artifact_id, source_id, document_id, chunk_id, role)
    select gen_random_uuid()::text, ${input.toArtifactId}, s.source_id, s.document_id, s.chunk_id, s.role
    from ${artifactSources} s
    where s.artifact_id = ${input.fromArtifactId}
      and s.role = 'input'
      and not exists (
        select 1 from ${artifactSources} t
        where t.artifact_id = ${input.toArtifactId}
          and t.role = 'input'
          and t.source_id is not distinct from s.source_id
          and t.document_id is not distinct from s.document_id
          and t.chunk_id is not distinct from s.chunk_id
      )
  `);
}
