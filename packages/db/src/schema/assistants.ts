import { desc, sql } from "drizzle-orm";
import {
  assistantDecisionActionSchema,
  assistantStatusReasonSchema,
  assistantStatusSchema,
  assistantTriggerSourceSchema,
  assistantTriggerStatusSchema,
  feedItemKindSchema,
  ticketBlockedReasonSchema,
  ticketOriginSchema,
  ticketOutcomeSchema,
  ticketStageSchema,
  type AssistantDecisionAction,
  type AssistantStatus,
  type AssistantStatusReason,
  type AssistantTriggerSource,
  type AssistantTriggerStatus,
  type FeedItemKind,
  type TicketBlockedReason,
  type TicketOrigin,
  type TicketOutcome,
  type TicketStage,
} from "@sourceweft/contracts/assistants";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";

/**
 * A workspace assistant: one standing router per workspace that turns member
 * messages and worker reports into tickets. `router_thread_id` names the
 * router's own conversation thread, created lazily on first run, so it is a
 * plain id with no foreign key (same reasoning as `assistant_tickets.worker_thread_id`
 * below). At most one router run is in flight at a time, tracked by
 * `current_router_run_id`/`current_router_batch_key`.
 */
export const assistants = pgTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    routerThreadId: text("router_thread_id").notNull(),
    stewardUserId: text("steward_user_id").notNull(),
    status: text("status").$type<AssistantStatus>().notNull().default("active"),
    statusReason: text("status_reason").$type<AssistantStatusReason>(),
    // The router run and batch currently in flight, if any; both null when
    // the router is idle. At most one router run per assistant at a time.
    currentRouterRunId: text("current_router_run_id"),
    currentRouterBatchKey: text("current_router_batch_key"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "assistants_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    // One assistant per workspace.
    unique("assistants_workspace_uq").on(table.workspaceId),
    check(
      "assistants_status_check",
      sql`${table.status} in (${sqlEnumList(assistantStatusSchema.options)})`,
    ),
    check(
      "assistants_status_reason_check",
      sql`${table.statusReason} is null or ${table.statusReason} in (${sqlEnumList(assistantStatusReasonSchema.options)})`,
    ),
    check("assistants_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * One event on the router's radar: a member message or a worker's report.
 * `dedupe_key` absorbs a double-click or a network retry into a single row.
 * `ticket_id` names the reporting ticket for a `worker_report` trigger;
 * `routed_ticket_id` is filled in once a decision routes the trigger to a
 * ticket (new or existing). Neither carries a foreign key: the decision that
 * fills `routed_ticket_id` and the ticket itself are written in the same
 * transaction as `assistant_decisions`, and `ticket_id` only ever names a
 * ticket under the same assistant, already enforced by `assistant_id`.
 */
export const assistantTriggers = pgTable(
  "assistant_triggers",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    sourceKind: text("source_kind").$type<AssistantTriggerSource>().notNull(),
    payerUserId: text("payer_user_id"),
    authorUserId: text("author_user_id"),
    dedupeKey: text("dedupe_key").notNull(),
    text: text("text").notNull(),
    ticketId: text("ticket_id"),
    routedTicketId: text("routed_ticket_id"),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: text("status")
      .$type<AssistantTriggerStatus>()
      .notNull()
      .default("pending_eval"),
    evalAttempts: integer("eval_attempts").notNull().default(0),
    routerBatchKey: text("router_batch_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "assistant_triggers_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_triggers_assistant_fk",
      columns: [table.assistantId],
      foreignColumns: [assistants.id],
    }).onDelete("cascade"),
    // A double-click or network retry produces one row, one event.
    unique("assistant_triggers_assistant_dedupe_uq").on(
      table.assistantId,
      table.dedupeKey,
    ),
    check(
      "assistant_triggers_source_kind_check",
      sql`${table.sourceKind} in (${sqlEnumList(assistantTriggerSourceSchema.options)})`,
    ),
    check(
      "assistant_triggers_status_check",
      sql`${table.status} in (${sqlEnumList(assistantTriggerStatusSchema.options)})`,
    ),
    check(
      "assistant_triggers_text_length_check",
      sql`char_length(${table.text}) <= 4000`,
    ),
    check(
      "assistant_triggers_eval_attempts_check",
      sql`${table.evalAttempts} >= 0`,
    ),
    index("assistant_triggers_assistant_status_payer_created_idx").on(
      table.assistantId,
      table.status,
      table.payerUserId,
      table.createdAt,
    ),
  ],
);

/**
 * What the router decided about one trigger, in one batch. The unique pair
 * (trigger, batch) keeps a re-evaluated batch from recording a trigger's
 * decision twice.
 */
export const assistantDecisions = pgTable(
  "assistant_decisions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    triggerId: text("trigger_id").notNull(),
    routerBatchKey: text("router_batch_key").notNull(),
    action: text("action").$type<AssistantDecisionAction>().notNull(),
    ticketId: text("ticket_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "assistant_decisions_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_decisions_assistant_fk",
      columns: [table.assistantId],
      foreignColumns: [assistants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_decisions_trigger_fk",
      columns: [table.triggerId],
      foreignColumns: [assistantTriggers.id],
    }).onDelete("cascade"),
    unique("assistant_decisions_trigger_batch_uq").on(
      table.triggerId,
      table.routerBatchKey,
    ),
    check(
      "assistant_decisions_action_check",
      sql`${table.action} in (${sqlEnumList(assistantDecisionActionSchema.options)})`,
    ),
  ],
);

/**
 * One piece of work, each with its own worker thread. `worker_thread_id` is a
 * plain id, not a foreign key: like `assistants.router_thread_id`, the thread
 * is created lazily on the ticket's first run. P1 fixes `origin` at
 * `explicit`; the column still carries the full vocabulary so an inferred
 * ticket needs no migration later.
 */
export const assistantTickets = pgTable(
  "assistant_tickets",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    workerThreadId: text("worker_thread_id").notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    payerUserId: text("payer_user_id").notNull(),
    origin: text("origin").$type<TicketOrigin>().notNull().default("explicit"),
    stage: text("stage").$type<TicketStage>().notNull().default("queued"),
    outcome: text("outcome").$type<TicketOutcome>(),
    blockedReason: text("blocked_reason").$type<TicketBlockedReason>(),
    creditCap: numeric("credit_cap").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastReportSummary: text("last_report_summary"),
    currentRunId: text("current_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "assistant_tickets_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_tickets_assistant_fk",
      columns: [table.assistantId],
      foreignColumns: [assistants.id],
    }).onDelete("cascade"),
    check(
      "assistant_tickets_origin_check",
      sql`${table.origin} in (${sqlEnumList(ticketOriginSchema.options)})`,
    ),
    check(
      "assistant_tickets_stage_check",
      sql`${table.stage} in (${sqlEnumList(ticketStageSchema.options)})`,
    ),
    check(
      "assistant_tickets_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in (${sqlEnumList(ticketOutcomeSchema.options)})`,
    ),
    check(
      "assistant_tickets_blocked_reason_check",
      sql`${table.blockedReason} is null or ${table.blockedReason} in (${sqlEnumList(ticketBlockedReasonSchema.options)})`,
    ),
    check("assistant_tickets_credit_cap_check", sql`${table.creditCap} >= 0`),
    check(
      "assistant_tickets_consecutive_failures_check",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    index("assistant_tickets_assistant_stage_created_idx").on(
      table.assistantId,
      table.stage,
      table.createdAt,
    ),
  ],
);

/**
 * The shared timeline a member reads to follow the assistant and its
 * tickets. `reply_to_item_id` nests one level, mirroring
 * `messages.parentMessageId`. `trigger_id`/`ticket_id` are plain ids with no
 * foreign key: a feed item outlives neither its assistant (cascades with it)
 * nor needs to outlive the trigger or ticket it names, so no cascade coupling
 * is needed beyond that.
 */
export const assistantFeedItems = pgTable(
  "assistant_feed_items",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    kind: text("kind").$type<FeedItemKind>().notNull(),
    authorUserId: text("author_user_id"),
    text: text("text").notNull(),
    triggerId: text("trigger_id"),
    ticketId: text("ticket_id"),
    replyToItemId: text("reply_to_item_id").references(
      (): AnyPgColumn => assistantFeedItems.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "assistant_feed_items_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_feed_items_assistant_fk",
      columns: [table.assistantId],
      foreignColumns: [assistants.id],
    }).onDelete("cascade"),
    check(
      "assistant_feed_items_kind_check",
      sql`${table.kind} in (${sqlEnumList(feedItemKindSchema.options)})`,
    ),
    check(
      "assistant_feed_items_text_length_check",
      sql`char_length(${table.text}) <= 4000`,
    ),
    index("assistant_feed_items_assistant_created_id_idx").on(
      table.assistantId,
      desc(table.createdAt),
      desc(table.id),
    ),
  ],
);
