import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  skillCategories,
  skillDefinitionCategories,
  skillDefinitions,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import { setRegistryVisibility } from "../registry/review";
import { recordSkillMarketEvent } from "./events";
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
    await tx
      .update(skillDefinitions)
      .set({ categoriesSetBy: "auto" })
      .where(eq(skillDefinitions.id, skillId));
  });
}

/** Visibility and hold as they stand, for an event's `from`. */
async function readListingState(skillId: string) {
  const [row] = await db
    .select({
      visibility: skillDefinitions.visibility,
      listingHoldBy: skillDefinitions.listingHoldBy,
    })
    .from(skillDefinitions)
    .where(eq(skillDefinitions.id, skillId))
    .limit(1);
  return row ?? null;
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
  /**
   * An admin listing by hand also lifts any hold: left in place, it would be
   * a lie about a skill that is public again.
   */
  releaseHold?: boolean;
}) {
  const before = await readListingState(input.skillId);
  if (input.releaseHold) {
    await releaseSkillListingHold({ skillId: input.skillId });
  }
  // Its commit must be its repository's, not a fork's served under its name.
  await ensureListingProvenance(input.skillId);
  await prepareSkillListing(input.skillId);
  const result = await setRegistryVisibility({
    skillId: input.skillId,
    visibility: "public",
    actorUserId: input.actorUserId,
  });
  if (result) {
    const automatic = input.actorUserId === SKILL_AUTO_LIST_ACTOR;
    await recordSkillMarketEvent({
      skillId: input.skillId,
      actorKind: automatic ? "system" : "admin",
      actorUserId: input.actorUserId,
      action: automatic ? "listing.auto_listed" : "listing.listed",
      detail: {
        visibility: { from: before?.visibility ?? null, to: "public" },
        ...(input.releaseHold
          ? {
              listingHoldBy: { from: before?.listingHoldBy ?? null, to: null },
            }
          : {}),
      },
    });
  }
  return result;
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
  const before = await readListingState(input.skillId);
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
  await recordSkillMarketEvent({
    skillId: input.skillId,
    actorKind: "admin",
    actorUserId: input.actorUserId,
    action: "listing.withdrawn",
    detail: {
      visibility: { from: before?.visibility ?? null, to: "restricted" },
      listingHoldBy: { from: before?.listingHoldBy ?? null, to: "admin" },
    },
  });
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

/**
 * The skill's author's say over it, and only its author's: the skill must be
 * claimed (`claimed_at`) and the caller must be the claimant, who is its
 * owner from the claim on. Whoever merely imported an unclaimed skill has no
 * say — whether an unclaimed skill is public is decided by the platform's
 * rules (the scan, provenance, auto-listing) and by market admins. Importing
 * a public repository's skill is not authoring it.
 */
function authorOwnsSkill(input: { skillId: string; userId: string }) {
  return and(
    eq(skillDefinitions.id, input.skillId),
    eq(skillDefinitions.sourceType, "registry_github"),
    eq(skillDefinitions.status, "active"),
    eq(skillDefinitions.ownerUserId, input.userId),
    isNotNull(skillDefinitions.claimedAt),
  );
}

/**
 * The author's view of their skill's listing; null for anyone else, the
 * importer of an unclaimed skill included.
 */
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
    .where(authorOwnsSkill(input))
    .limit(1);
  if (!definition) return null;
  return {
    skillId: input.skillId,
    listed: definition.visibility === "public",
    heldBy: definition.listingHoldBy,
  };
}

/**
 * The author of a claimed skill decides whether it may be on the public
 * market (see `authorOwnsSkill`).
 *
 * `listed: false` takes it off (or keeps it off) and holds it as the owner.
 * `listed: true` only lifts the owner's own hold — whether the skill then lists
 * is the same decision as for any other skill (clean → listed, flagged → the
 * admin's queue), so this is never a way around a flag or an admin's hold.
 * null when the skill is not a claimed, active registry skill of this user's.
 */
export async function setOwnerSkillListing(input: {
  skillId: string;
  userId: string;
  listed: boolean;
  /** Recorded on the event when a larger act did this (`claim.removed`). */
  via?: string;
}): Promise<OwnerSkillListing | null> {
  const [definition] = await db
    .select({
      visibility: skillDefinitions.visibility,
      listingHold: skillDefinitions.listingHold,
      listingHoldBy: skillDefinitions.listingHoldBy,
    })
    .from(skillDefinitions)
    .where(authorOwnsSkill(input))
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

  const ownerEvent = (action: string, to: "owner" | null) =>
    recordSkillMarketEvent({
      skillId: input.skillId,
      actorKind: "owner",
      actorUserId: input.userId,
      action,
      detail: {
        visibility: {
          from: definition.visibility,
          to: to === "owner" ? "restricted" : definition.visibility,
        },
        listingHoldBy: { from: definition.listingHoldBy, to },
        ...(input.via ? { via: input.via } : {}),
      },
    });

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
    // Asking again for what already holds is not a decision worth a row.
    if (
      definition.listingHoldBy !== "owner" ||
      definition.visibility === "public"
    ) {
      await ownerEvent("listing.owner_private", "owner");
    }
    return { skillId: input.skillId, listed: false, heldBy: "owner" };
  }

  await releaseSkillListingHold({ skillId: input.skillId });
  if (definition.listingHold) {
    await ownerEvent("listing.owner_allowed", null);
  }
  return {
    skillId: input.skillId,
    listed: definition.visibility === "public",
    heldBy: null,
  };
}

/** The value a column holds now, read inside the transaction about to change it. */
async function lockDefinition(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  skillId: string,
) {
  const [row] = await tx
    .select()
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * `verified` is a market admin's call alone; nothing else writes it (a new
 * version clears it — `registry/repository.ts`).
 */
export async function setSkillVerified(input: {
  skillId: string;
  verified: boolean;
  actorUserId: string;
}) {
  return db.transaction(async (tx) => {
    const before = await lockDefinition(tx, input.skillId);
    if (!before) return null;
    const [row] = await tx
      .update(skillDefinitions)
      .set({ verified: input.verified, updatedAt: new Date() })
      .where(eq(skillDefinitions.id, input.skillId))
      .returning({
        skillId: skillDefinitions.id,
        verified: skillDefinitions.verified,
      });
    await recordSkillMarketEvent(
      {
        skillId: input.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: "verified.set",
        detail: { verified: { from: before.verified, to: input.verified } },
      },
      tx,
    );
    return row ?? null;
  });
}

/**
 * An admin marks a skill featured, or not. The platform's import sets
 * `featured` for a short list of major publishers; recording the choice as
 * the admin's (`featured_set_by = 'admin'`) is what keeps a later import from
 * overwriting it (`registry/repository.ts`).
 */
export async function setSkillFeatured(input: {
  skillId: string;
  featured: boolean;
  actorUserId: string;
}) {
  return db.transaction(async (tx) => {
    const before = await lockDefinition(tx, input.skillId);
    if (!before) return null;
    const [row] = await tx
      .update(skillDefinitions)
      .set({
        featured: input.featured,
        featuredSetBy: "admin",
        updatedAt: new Date(),
      })
      .where(eq(skillDefinitions.id, input.skillId))
      .returning({
        skillId: skillDefinitions.id,
        featured: skillDefinitions.featured,
      });
    await recordSkillMarketEvent(
      {
        skillId: input.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: "featured.set",
        detail: {
          featured: { from: before.featured, to: input.featured },
          featuredSetBy: { from: before.featuredSetBy, to: "admin" },
        },
      },
      tx,
    );
    return row ?? null;
  });
}

/**
 * Replaces a skill's categories with an admin's choice, recorded as the
 * admin's (`categories_set_by = 'admin'`) so a bulk re-inference leaves it.
 */
export async function setSkillCategories(input: {
  skillId: string;
  categorySlugs: string[];
  actorUserId: string;
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
      .select({
        id: skillDefinitions.id,
        categoriesSetBy: skillDefinitions.categoriesSetBy,
      })
      .from(skillDefinitions)
      .where(eq(skillDefinitions.id, input.skillId))
      .limit(1)
      .for("update");
    if (!definition) return null;
    const from = await categorySlugsIn(tx, input.skillId);
    await replaceCategories(tx, input.skillId, slugs, "admin");
    await recordSkillMarketEvent(
      {
        skillId: input.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: "categories.set",
        detail: {
          categorySlugs: { from, to: slugs },
          categoriesSetBy: { from: definition.categoriesSetBy, to: "admin" },
        },
      },
      tx,
    );
    return { skillId: input.skillId, categorySlugs: slugs };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function categorySlugsIn(tx: Tx, skillId: string): Promise<string[]> {
  const rows = await tx
    .select({ slug: skillCategories.slug })
    .from(skillDefinitionCategories)
    .innerJoin(
      skillCategories,
      eq(skillCategories.id, skillDefinitionCategories.categoryId),
    )
    .where(eq(skillDefinitionCategories.skillId, skillId))
    .orderBy(skillCategories.sortOrder);
  return rows.map((row) => row.slug);
}

async function replaceCategories(
  tx: Tx,
  skillId: string,
  slugs: string[],
  setBy: "auto" | "admin",
) {
  await tx
    .delete(skillDefinitionCategories)
    .where(eq(skillDefinitionCategories.skillId, skillId));
  await tx
    .insert(skillDefinitionCategories)
    .values(
      slugs.map((slug) => ({ skillId, categoryId: skillCategoryId(slug) })),
    );
  await tx
    .update(skillDefinitions)
    .set({ categoriesSetBy: setBy, updatedAt: new Date() })
    .where(eq(skillDefinitions.id, skillId));
}

const sameSlugs = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Files one skill under the categories inferred from its text now, even where
 * an admin had picked them — asking for it is the admin's act; the choice is
 * then the classifier's again (`auto`). null for anything that is not a
 * registry skill.
 */
export async function reinferSkillCategories(input: {
  skillId: string;
  actorUserId: string;
}): Promise<{ skillId: string; categorySlugs: string[] } | null> {
  await ensureSkillCategories();
  return db.transaction(async (tx) => {
    const definition = await lockDefinition(tx, input.skillId);
    if (!definition) return null;
    const from = await categorySlugsIn(tx, input.skillId);
    const slugs = classifySkillCategories({
      name: definition.displayName,
      description: definition.description,
    });
    await replaceCategories(tx, input.skillId, slugs, "auto");
    await recordSkillMarketEvent(
      {
        skillId: input.skillId,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: "categories.reinferred",
        detail: {
          categorySlugs: { from, to: slugs },
          categoriesSetBy: { from: definition.categoriesSetBy, to: "auto" },
        },
      },
      tx,
    );
    return { skillId: input.skillId, categorySlugs: slugs };
  });
}

/** Skills re-inferred per transaction in the bulk pass. */
export const REINFER_CATEGORIES_BATCH_SIZE = 200;

/**
 * Files every active community skill already filed under inferred categories
 * (never one an admin picked) under what the classifier says now — after the
 * taxonomy or the classifier changed. In batches, each its own transaction,
 * keyed by id; a skill an admin corrects meanwhile is skipped (re-checked
 * under the row lock). Each skill whose categories changed gets an event,
 * and the run as a whole one more.
 */
export async function reinferAllSkillCategories(input: {
  actorUserId: string;
  batchSize?: number;
  /** Narrows the pass to these skills; the admin route passes nothing. */
  onlySkillIds?: string[];
}): Promise<{ considered: number; changed: number }> {
  await ensureSkillCategories();
  const batchSize = input.batchSize ?? REINFER_CATEGORIES_BATCH_SIZE;
  const tally = { considered: 0, changed: 0 };
  let afterId: string | null = null;
  for (;;) {
    const ids: string[] = (
      await db
        .select({ id: skillDefinitions.id })
        .from(skillDefinitions)
        .where(
          and(
            eq(skillDefinitions.sourceType, "registry_github"),
            eq(skillDefinitions.status, "active"),
            sql`${skillDefinitions.categoriesSetBy} is distinct from 'admin'`,
            // Filed already: a skill gets its first categories when it is
            // first listed (`prepareSkillListing`), not from this pass.
            sql`exists (select 1 from ${skillDefinitionCategories} where ${skillDefinitionCategories.skillId} = ${skillDefinitions.id})`,
            afterId ? sql`${skillDefinitions.id} > ${afterId}` : undefined,
            input.onlySkillIds
              ? inArray(skillDefinitions.id, input.onlySkillIds)
              : undefined,
          ),
        )
        .orderBy(skillDefinitions.id)
        .limit(batchSize)
    ).map((row) => row.id);
    if (ids.length === 0) break;
    afterId = ids.at(-1)!;
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skillDefinitions)
        .where(
          and(
            inArray(skillDefinitions.id, ids),
            sql`${skillDefinitions.categoriesSetBy} is distinct from 'admin'`,
          ),
        )
        .orderBy(skillDefinitions.id)
        .for("update");
      for (const definition of rows) {
        tally.considered += 1;
        const from = await categorySlugsIn(tx, definition.id);
        const slugs = classifySkillCategories({
          name: definition.displayName,
          description: definition.description,
        });
        if (sameSlugs(from, slugs)) {
          // Filed before `categories_set_by` existed: now known to be inferred.
          if (definition.categoriesSetBy !== "auto") {
            await tx
              .update(skillDefinitions)
              .set({ categoriesSetBy: "auto" })
              .where(eq(skillDefinitions.id, definition.id));
          }
          continue;
        }
        await replaceCategories(tx, definition.id, slugs, "auto");
        tally.changed += 1;
        await recordSkillMarketEvent(
          {
            skillId: definition.id,
            actorKind: "admin",
            actorUserId: input.actorUserId,
            action: "categories.reinferred",
            detail: { categorySlugs: { from, to: slugs }, bulk: true },
          },
          tx,
        );
      }
    });
    if (ids.length < batchSize) break;
  }
  await recordSkillMarketEvent({
    actorKind: "admin",
    actorUserId: input.actorUserId,
    action: "categories.reinferred",
    detail: { bulk: true, ...tally },
  });
  return tally;
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
