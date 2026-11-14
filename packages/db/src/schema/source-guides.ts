import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  sourceGuideErrorCodeSchema,
  sourceGuideStatusSchema,
  sourceGuideTriggerSchema,
  type SourceGuideContent,
} from "@sourceweft/contracts/sources";
import { sqlEnumList } from "./shared";
import { workspaces } from "./identity-workspace";
import { sources } from "./sources";

type GuideStatus = (typeof sourceGuideStatusSchema.options)[number];
type GuideTrigger = (typeof sourceGuideTriggerSchema.options)[number];
type GuideErrorCode = (typeof sourceGuideErrorCodeSchema.options)[number];

/**
 * One guide per source: summary, key topics and suggested questions generated
 * from the indexed content. `content_hash` is the source content hash the
 * guide was generated from, so a changed source marks it stale.
 */
export const sourceGuides = pgTable(
  "source_guides",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    status: text("status").$type<GuideStatus>().notNull().default("pending"),
    contentJson: jsonb("content_json").$type<SourceGuideContent>(),
    errorCode: text("error_code").$type<GuideErrorCode>(),
    trigger: text("trigger").$type<GuideTrigger>().notNull(),
    /** Who was charged for the generation; null until one is resolved. */
    payerUserId: text("payer_user_id"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "source_guides_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("source_guides_source_uq").on(table.sourceId),
    index("source_guides_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    check(
      "source_guides_status_check",
      sql`${table.status} in (${sqlEnumList(sourceGuideStatusSchema.options)})`,
    ),
    check(
      "source_guides_trigger_check",
      sql`${table.trigger} in (${sqlEnumList(sourceGuideTriggerSchema.options)})`,
    ),
    check(
      "source_guides_error_code_check",
      sql`${table.errorCode} is null or ${table.errorCode} in (${sqlEnumList(sourceGuideErrorCodeSchema.options)})`,
    ),
  ],
);
