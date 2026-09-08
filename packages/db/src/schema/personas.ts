import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";

type PersonaModelSettingsJson = {
  llmProfileAlias?: string | null;
  llmModelAlias?: string | null;
};
type PersonaFilesystemPolicy = "default" | "read_only";

/**
 * Workspace-authored personas. Built-in personas are code (the read-only
 * roster in `threads/agent/personas/builtin.ts`); a row here is what a member
 * gets by cloning a built-in (or another row) and editing it, the same
 * "index + install" shape as an agent marketplace. `threads.persona_id` points
 * at a built-in slug or at `id` here; no FK, because half the ids are code.
 */
export const agentPersonas = pgTable(
  "agent_personas",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Human slug derived from the name; unique per workspace, display only. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    avatar: text("avatar"),
    modelSettingsJson: jsonb("model_settings_json")
      .$type<PersonaModelSettingsJson>()
      .notNull()
      .default(emptyJsonObject),
    /** Null = inherit the thread's tools; a list restricts to exactly these. */
    toolAllowlistJson: jsonb("tool_allowlist_json").$type<string[] | null>(),
    /** `read_only` keeps a clone of explore/plan from writing files. */
    filesystemPolicy: text("filesystem_policy")
      .$type<PersonaFilesystemPolicy>()
      .notNull()
      .default("default"),
    /** The built-in slug or persona id this row was cloned from. */
    clonedFrom: text("cloned_from"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_personas_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    unique("agent_personas_workspace_slug_uq").on(
      table.workspaceId,
      table.slug,
    ),
    check(
      "agent_personas_filesystem_policy_check",
      sql`${table.filesystemPolicy} in ('default', 'read_only')`,
    ),
    index("agent_personas_workspace_created_idx").on(
      table.workspaceId,
      desc(table.createdAt),
    ),
  ],
);
