import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";

/**
 * A person's in-app inbox. Generic on purpose: `kind` is a code-side registry
 * (the table does not constrain it), and `ref_kind`/`ref_id` point at whatever
 * the notification is about. `payload_json` holds only what is safe to show on
 * a list row; never prompts or result text.
 *
 * Repeats of the same event for the same subject within the merge window fold
 * into one row (`occurrence_count`, `last_occurred_at`) so a failing job does
 * not flood the inbox.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    lastOccurredAt: timestamp("last_occurred_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    emailedAt: timestamp("emailed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("notifications_user_inbox_idx").on(
      table.userId,
      table.teamId,
      table.readAt,
      desc(table.lastOccurredAt),
    ),
    index("notifications_merge_idx").on(
      table.userId,
      table.kind,
      table.refId,
      desc(table.createdAt),
    ),
    check("notifications_count_check", sql`${table.occurrenceCount} >= 1`),
  ],
);
