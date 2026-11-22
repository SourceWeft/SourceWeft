import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  researchErrorCodeSchema,
  researchPhaseSchema,
  researchStatusSchema,
  type ResearchCitation,
  type ResearchLedgerEntry,
  type ResearchProgress,
} from "@sourceweft/contracts/source-research";
import { sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";

type ResearchStatus = (typeof researchStatusSchema.options)[number];
type ResearchPhase = (typeof researchPhaseSchema.options)[number];
type ResearchErrorCode = (typeof researchErrorCodeSchema.options)[number];

/**
 * One deep-research run per row: the plan, the evidence ledger and the final
 * cited report live here so a run survives worker restarts and can be resumed
 * or cancelled.
 */
export const sourceResearchRuns = pgTable(
  "research_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").notNull(),
    topic: text("topic").notNull(),
    status: text("status").$type<ResearchStatus>().notNull().default("queued"),
    phase: text("phase").$type<ResearchPhase>(),
    progressJson: jsonb("progress_json")
      .$type<ResearchProgress>()
      .notNull()
      .default({ round: 0, searches: 0, pagesRead: 0, modelCalls: 0 }),
    planJson: jsonb("plan_json").$type<string[]>(),
    ledgerJson: jsonb("ledger_json")
      .$type<ResearchLedgerEntry[]>()
      .notNull()
      .default([]),
    reportMarkdown: text("report_markdown"),
    reportCitationsJson: jsonb("report_citations_json").$type<
      ResearchCitation[]
    >(),
    modelCalls: integer("model_calls").notNull().default(0),
    errorCode: text("error_code").$type<ResearchErrorCode>(),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "research_runs_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("research_runs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
    index("research_runs_user_status_idx").on(
      table.createdByUserId,
      table.status,
    ),
    check(
      "research_runs_status_check",
      sql`${table.status} in (${sqlEnumList(researchStatusSchema.options)})`,
    ),
    check(
      "research_runs_phase_check",
      sql`${table.phase} is null or ${table.phase} in (${sqlEnumList(researchPhaseSchema.options)})`,
    ),
    check(
      "research_runs_error_code_check",
      sql`${table.errorCode} is null or ${table.errorCode} in (${sqlEnumList(researchErrorCodeSchema.options)})`,
    ),
  ],
);
