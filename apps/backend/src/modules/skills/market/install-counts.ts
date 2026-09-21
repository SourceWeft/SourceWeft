import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";

/**
 * Recomputes `skill_definitions.install_count` from `workspace_skills`: the
 * workspaces that have the skill switched on, the same number
 * `countSkillInstalls` reports. Done here on a timer rather than on
 * install/uninstall, so sorting the market by popularity costs the install path
 * nothing. Only rows whose count changed are written.
 */
export async function refreshSkillInstallCounts(): Promise<void> {
  await db.execute(sql`
    update skill_definitions d
    set install_count = c.installs
    from (
      select s.id, count(distinct w.workspace_id)::int as installs
      from skill_definitions s
      left join workspace_skills w on w.skill_id = s.id and w.enabled = true
      group by s.id
    ) c
    where d.id = c.id
      and d.install_count <> c.installs
  `);
}
