import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  skillCategories,
  skillDefinitionCategories,
  skillDefinitions,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import { setRegistryVisibility } from "../registry/review";
import { ensureListingProvenance } from "./provenance";
import {
  classifySkillCategories,
  getSkillCategoryDefinition,
  skillCategoryDefinitions,
  skillCategoryId,
} from "./taxonomy";

/**
 * Putting a skill on the public market and taking it off again.
 *
 * `listSkillPublicly` is the one way a skill is listed: the admin action and
 * the scheduler's auto-listing pass both go through it, so a listed skill
 * always has its `listed_at` and its categories, whoever listed it.
 */

/** Recorded as the actor when the auto-listing pass lists a skill. */
export const SKILL_AUTO_LIST_ACTOR = "system:auto-list";

/** Writes the taxonomy into `skill_categories`. Idempotent; a dozen rows. */
export async function syncSkillCategories(): Promise<void> {
  await db
    .insert(skillCategories)
    .values(
      skillCategoryDefinitions.map((definition, index) => ({
        id: skillCategoryId(definition.slug),
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        sortOrder: index,
      })),
    )
    .onConflictDoUpdate({
      target: skillCategories.id,
      set: {
        slug: sql`excluded.slug`,
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        sortOrder: sql`excluded.sort_order`,
      },
    });
}

let categoriesSynced: Promise<void> | null = null;

/** `syncSkillCategories`, once per process — the taxonomy is a code constant. */
export function ensureSkillCategories(): Promise<void> {
  categoriesSynced ??= syncSkillCategories().catch((error) => {
    categoriesSynced = null;
    throw error;
  });
  return categoriesSynced;
}

/**
 * Stamps `listed_at` (first listing only — it is the keyset key for "newest"
 * and must not move) and files the skill under inferred categories unless it
 * already has some, so an admin's correction survives a re-listing.
 */
export async function prepareSkillListing(skillId: string): Promise<void> {
  await ensureSkillCategories();
  await db.transaction(async (tx) => {
    const [definition] = await tx
      .select({
        displayName: skillDefinitions.displayName,
        description: skillDefinitions.description,
      })
      .from(skillDefinitions)
      .where(eq(skillDefinitions.id, skillId))
      .limit(1)
      .for("update");
    if (!definition) return;

    await tx
      .update(skillDefinitions)
      .set({ listedAt: sql`coalesce(${skillDefinitions.listedAt}, now())` })
      .where(eq(skillDefinitions.id, skillId));

    const [existing] = await tx
      .select({ categoryId: skillDefinitionCategories.categoryId })
      .from(skillDefinitionCategories)
      .where(eq(skillDefinitionCategories.skillId, skillId))
      .limit(1);
    if (existing) return;

    const slugs = classifySkillCategories({
      name: definition.displayName,
      description: definition.description,
    });
    await tx
      .insert(skillDefinitionCategories)
      .values(
        slugs.map((slug) => ({ skillId, categoryId: skillCategoryId(slug) })),
      )
      .onConflictDoNothing();
  });
}

/**
 * Lists a registry skill on the public market. Returns null when the skill is
 * not an active registry skill; throws `REGISTRY_NOT_PUBLISHED` when it has no
 * published current version to show.
 *
 * The listing data is written before the visibility flips: if the flip fails
 * the skill is simply still unlisted, never public-but-undated.
 */
export async function listSkillPublicly(input: {
  skillId: string;
  actorUserId: string;
}) {
  // Its commit must be its repository's, not a fork's served under its name.
  await ensureListingProvenance(input.skillId);
  await prepareSkillListing(input.skillId);
  return setRegistryVisibility({
    skillId: input.skillId,
    visibility: "public",
    actorUserId: input.actorUserId,
  });
}

/**
 * Takes a skill off the public market and holds it, so the auto-listing pass
 * does not put it back on the next tick. Workspaces that installed it keep it:
 * installing granted them an entitlement, which a `restricted` skill honors.
 */
export async function delistSkill(input: {
  skillId: string;
  actorUserId: string;
}) {
  const result = await setRegistryVisibility({
    skillId: input.skillId,
    visibility: "restricted",
    actorUserId: input.actorUserId,
  });
  if (!result) return null;
  await db
    .update(skillDefinitions)
    .set({ listingHold: true, listingHoldBy: "admin", updatedAt: new Date() })
    .where(eq(skillDefinitions.id, input.skillId));
  return { ...result, listingHold: true };
}

/** Lets the auto-listing pass consider the skill again. Does not list it. */
export async function releaseSkillListingHold(input: { skillId: string }) {
  const [row] = await db
    .update(skillDefinitions)
    .set({ listingHold: false, listingHoldBy: null, updatedAt: new Date() })
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .returning({ skillId: skillDefinitions.id });
  return row ? { ...row, listingHold: false } : null;
}

export type OwnerSkillListing = {
  skillId: string;
  /** On the public market right now. */
  listed: boolean;
  heldBy: "admin" | "owner" | null;
};

/** The owner's view of their skill's listing; null for anyone else's skill. */
export async function getOwnerSkillListing(input: {
  skillId: string;
  userId: string;
}): Promise<OwnerSkillListing | null> {
  const [definition] = await db
    .select({
      visibility: skillDefinitions.visibility,
      listingHoldBy: skillDefinitions.listingHoldBy,
    })
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.ownerUserId, input.userId),
      ),
    )
    .limit(1);
  if (!definition) return null;
  return {
    skillId: input.skillId,
    listed: definition.visibility === "public",
    heldBy: definition.listingHoldBy,
  };
}

/**
 * The person who imported a skill decides whether it may be on the public
 * market: a clean skill lists itself, and importing something for your own use
 * must not mean publishing it.
 *
 * `listed: false` takes it off (or keeps it off) and holds it as the owner.
 * `listed: true` only lifts the owner's own hold — whether the skill then lists
 * is the same decision as for any other skill (clean → listed, flagged → the
 * admin's queue), so this is never a way around a flag or an admin's hold.
 * null when the skill is not this user's active registry skill.
 */
export async function setOwnerSkillListing(input: {
  skillId: string;
  userId: string;
  listed: boolean;
}): Promise<OwnerSkillListing | null> {
  const [definition] = await db
    .select({
      visibility: skillDefinitions.visibility,
      listingHold: skillDefinitions.listingHold,
      listingHoldBy: skillDefinitions.listingHoldBy,
    })
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
        eq(skillDefinitions.ownerUserId, input.userId),
      ),
    )
    .limit(1);
  if (!definition) return null;

  if (definition.listingHoldBy === "admin") {
    if (input.listed) {
      throw new ContentError(
        409,
        "SKILL_LISTING_HELD_BY_ADMIN",
        "A market admin withdrew this skill; only they can list it again",
      );
    }
    return { skillId: input.skillId, listed: false, heldBy: "admin" };
  }

  if (!input.listed) {
    if (definition.visibility === "public") {
      await setRegistryVisibility({
        skillId: input.skillId,
        visibility: "restricted",
        actorUserId: input.userId,
      });
    }
    await db
      .update(skillDefinitions)
      .set({ listingHold: true, listingHoldBy: "owner", updatedAt: new Date() })
      .where(eq(skillDefinitions.id, input.skillId));
    return { skillId: input.skillId, listed: false, heldBy: "owner" };
  }

  await releaseSkillListingHold({ skillId: input.skillId });
  return {
    skillId: input.skillId,
    listed: definition.visibility === "public",
    heldBy: null,
  };
}

/** `verified` is a market admin's call alone; nothing else writes it. */
export async function setSkillVerified(input: {
  skillId: string;
  verified: boolean;
}) {
  const [row] = await db
    .update(skillDefinitions)
    .set({ verified: input.verified, updatedAt: new Date() })
    .where(
      and(
        eq(skillDefinitions.id, input.skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .returning({
      skillId: skillDefinitions.id,
      verified: skillDefinitions.verified,
    });
  return row ?? null;
}

/** Replaces a skill's categories with an admin's choice. */
export async function setSkillCategories(input: {
  skillId: string;
  categorySlugs: string[];
}) {
  const slugs = [...new Set(input.categorySlugs)];
  const unknown = slugs.filter((slug) => !getSkillCategoryDefinition(slug));
  if (slugs.length === 0 || unknown.length > 0) {
    throw new ContentError(
      400,
      "SKILL_CATEGORY_INVALID",
      slugs.length === 0
        ? "A skill needs at least one category"
        : `Unknown skill categories: ${unknown.join(", ")}`,
    );
  }
  await ensureSkillCategories();
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: skillDefinitions.id })
      .from(skillDefinitions)
      .where(eq(skillDefinitions.id, input.skillId))
      .limit(1)
      .for("update");
    if (!definition) return null;
    await tx
      .delete(skillDefinitionCategories)
      .where(eq(skillDefinitionCategories.skillId, input.skillId));
    await tx.insert(skillDefinitionCategories).values(
      slugs.map((slug) => ({
        skillId: input.skillId,
        categoryId: skillCategoryId(slug),
      })),
    );
    return { skillId: input.skillId, categorySlugs: slugs };
  });
}

/** Category slugs per skill, for the catalog rows being rendered. */
export async function listSkillCategorySlugs(
  skillIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (skillIds.length === 0) return result;
  const rows = await db
    .select({
      skillId: skillDefinitionCategories.skillId,
      slug: skillCategories.slug,
    })
    .from(skillDefinitionCategories)
    .innerJoin(
      skillCategories,
      eq(skillCategories.id, skillDefinitionCategories.categoryId),
    )
    .where(inArray(skillDefinitionCategories.skillId, skillIds))
    .orderBy(skillCategories.sortOrder);
  for (const row of rows) {
    const slugs = result.get(row.skillId) ?? [];
    slugs.push(row.slug);
    result.set(row.skillId, slugs);
  }
  return result;
}
