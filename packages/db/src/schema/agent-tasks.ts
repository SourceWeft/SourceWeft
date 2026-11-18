import { sql } from "drizzle-orm";
import {
  agentTaskResultTargetSchema,
  agentTaskStatusReasonSchema,
  agentTaskStatusSchema,
  type AgentTaskRequest,
  type AgentTaskResultTarget,
  type AgentTaskStatus,
  type AgentTaskStatusReason,
} from "@sourceweft/contracts/scheduled-tasks";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";

/**
 * A scheduled task: a saved prompt that runs as its owner, in the owner's
 * workspace. The time rule lives on the task's `task_schedules` row and every
 * run is a `schedule_occurrences` row; this table holds only the definition.
 *
 * `owner_user_id` is the run identity and the payer, and never changes.
 * Deleting a task archives it (`archived_at`) so its run history stays.
 */
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    // A closed snapshot of what the run starts with (`agentTaskRequestSchema`).
    requestJson: jsonb("request_json").$type<AgentTaskRequest>().notNull(),
    status: text("status").$type<AgentTaskStatus>().notNull().default("draft"),
    statusReason: text("status_reason").$type<AgentTaskStatusReason>(),
    statusChangedAt: timestamp("status_changed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    trialRunAt: timestamp("trial_run_at", { withTimezone: true, mode: "date" }),
    notifyOnSuccess: boolean("notify_on_success").notNull().default(true),
    notifyEmail: boolean("notify_email").notNull().default(true),
    resultTarget: text("result_target")
      .$type<AgentTaskResultTarget>()
      .notNull()
      .default("new_thread"),
    // Optimistic lock; bumped when the prompt, request or time rule changes.
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "agent_tasks_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    // Target of the schedule's composite foreign key, so a schedule can only
    // point at a task with the same workspace, team and owner.
    unique("agent_tasks_id_workspace_team_owner_uq").on(
      table.id,
      table.workspaceId,
      table.teamId,
      table.ownerUserId,
    ),
    check(
      "agent_tasks_status_check",
      sql`${table.status} in (${sqlEnumList(agentTaskStatusSchema.options)})`,
    ),
    check(
      "agent_tasks_status_reason_check",
      sql`${table.statusReason} is null or ${table.statusReason} in (${sqlEnumList(agentTaskStatusReasonSchema.options)})`,
    ),
    check(
      "agent_tasks_result_target_check",
      sql`${table.resultTarget} in (${sqlEnumList(agentTaskResultTargetSchema.options)})`,
    ),
    check(
      "agent_tasks_name_length_check",
      sql`char_length(${table.name}) between 1 and 80`,
    ),
    check(
      "agent_tasks_prompt_length_check",
      sql`char_length(${table.prompt}) between 1 and 20000`,
    ),
    check(
      "agent_tasks_request_object_check",
      sql`jsonb_typeof(${table.requestJson}) = 'object'`,
    ),
    check(
      "agent_tasks_consecutive_failures_check",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check("agent_tasks_version_check", sql`${table.version} >= 1`),
    // A name is unique per owner and workspace among tasks that still exist.
    uniqueIndex("agent_tasks_owner_name_uq")
      .on(table.workspaceId, table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
    index("agent_tasks_owner_status_idx").on(
      table.teamId,
      table.ownerUserId,
      table.status,
    ),
  ],
);
