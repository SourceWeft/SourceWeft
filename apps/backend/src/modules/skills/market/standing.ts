import { and, eq } from "drizzle-orm";
import type { SkillMarketStanding } from "@sourceweft/contracts";
import { db, skillDefinitions } from "@sourceweft/db";
import { listSkillCategorySlugs } from "./listing";

/**
 * A community skill's standing on the market, as the admin screen shows it and
 * as every admin action answers: whether it is listed or held, vouched for,
 * where it is filed and how it is doing. Read fresh after an action rather
 * than assembled from what the action returned, so the answer is what is
 * stored. null for anything that is not an active registry skill.
 */
export async function getSkillMarketStanding(
  skillId: string,
): Promise<SkillMarketStanding | null> {
  const [definition] = await db
    .select()
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
      ),
    )
    .limit(1);
  if (!definition) {
    return null;
  }
  const categorySlugs =
    (await listSkillCategorySlugs([skillId])).get(skillId) ?? [];
  return {
    skillId: definition.id,
    slug: definition.slug,
    // The registry only ever holds these two (`skill_definitions_scope_check`).
    visibility: definition.visibility === "public" ? "public" : "restricted",
    listingHold: definition.listingHold,
    listingHoldBy: definition.listingHoldBy,
    verified: definition.verified,
    categorySlugs,
    installCount: definition.installCount,
    listedAt: definition.listedAt?.toISOString() ?? null,
  };
}
