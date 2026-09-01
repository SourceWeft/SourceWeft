import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";
import { sources } from "./sources";
import { messages, threads } from "./threads";

type NoteType = "manual" | "saved_response" | "generated";

export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    noteType: text("note_type").$type<NoteType>().notNull().default("manual"),
    title: text("title"),
    contentText: text("content_text"),
    contentJson: jsonb("content_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    isEditable: boolean("is_editable").notNull().default(true),
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
      name: "notes_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    check(
      "notes_note_type_check",
      sql`${table.noteType} in ('manual', 'saved_response', 'generated')`,
    ),
    index("notes_workspace_updated_idx").on(
      table.workspaceId,
      desc(table.updatedAt),
    ),
    index("notes_thread_updated_idx").on(table.threadId, desc(table.updatedAt)),
  ],
);

export const noteSources = pgTable(
  "note_sources",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.sourceId] }),
    index("note_sources_source_idx").on(table.sourceId),
  ],
);
