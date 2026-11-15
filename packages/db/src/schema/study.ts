import { desc, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { workspaces } from "./identity-workspace";
import { emptyJsonObject } from "./shared";

/**
 * Per-user learning state for study artifacts (flashcards, quizzes).
 *
 * Items are named by the stable `id` inside the artifact's content, never by a
 * row, so state survives regeneration. Rows belong to one user and are never
 * shown to others. `user_id` has no foreign key, like the other per-user
 * tables, because users live in the auth schema.
 */

/** The FSRS card of one user for one item; columns follow the ts-fsrs `Card`. */
export const studyReviewStates = pgTable(
  "study_review_states",
  {
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    /** 0 New, 1 Learning, 2 Review, 3 Relearning. */
    state: smallint("state").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
    // Double precision: the scheduler works in doubles, and a float4 round trip
    // would make the same history schedule differently after a reload.
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastReviewedAt: timestamp("last_reviewed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "study_review_states_pk",
      columns: [table.userId, table.artifactId, table.itemId],
    }),
    foreignKey({
      name: "study_review_states_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "study_review_states_state_check",
      sql`${table.state} between 0 and 3`,
    ),
    index("study_review_states_user_due_idx").on(table.userId, table.dueAt),
  ],
);

/**
 * One row per grade, appended and never updated. It is the data a later
 * per-user FSRS optimizer trains on, so it is kept from the first review.
 */
export const studyReviewLogs = pgTable(
  "study_review_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    /** The artifact version whose content the item was read from. */
    versionNo: integer("version_no").notNull(),
    /** 1 Again, 2 Hard, 3 Good, 4 Easy. */
    grade: smallint("grade").notNull(),
    stateBefore: smallint("state_before").notNull(),
    dueBefore: timestamp("due_before", { withTimezone: true, mode: "date" }),
    stabilityBefore: doublePrecision("stability_before"),
    difficultyBefore: doublePrecision("difficulty_before"),
    elapsedDays: integer("elapsed_days").notNull(),
    scheduledDays: integer("scheduled_days").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "study_review_logs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check("study_review_logs_grade_check", sql`${table.grade} between 1 and 4`),
    check(
      "study_review_logs_state_before_check",
      sql`${table.stateBefore} between 0 and 3`,
    ),
    check("study_review_logs_version_check", sql`${table.versionNo} > 0`),
    index("study_review_logs_user_item_idx").on(
      table.userId,
      table.artifactId,
      table.itemId,
      table.reviewedAt,
    ),
  ],
);

/** One sitting of a quiz; the server grades `answers` against the version. */
export const studyQuizAttempts = pgTable(
  "study_quiz_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    itemIds: jsonb("item_ids").$type<string[]>().notNull(),
    answers: jsonb("answers")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    score: integer("score"),
    total: integer("total").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "study_quiz_attempts_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check("study_quiz_attempts_version_check", sql`${table.versionNo} > 0`),
    check(
      "study_quiz_attempts_score_check",
      sql`${table.score} is null or (${table.score} >= 0 and ${table.score} <= ${table.total})`,
    ),
    index("study_quiz_attempts_user_artifact_idx").on(
      table.userId,
      table.artifactId,
      desc(table.startedAt),
    ),
  ],
);
