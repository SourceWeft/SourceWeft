import {
  currentSkillAnalysisModelKey,
  skillAnalysisQualityApproved,
} from "./analysis-quality";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";
import { applyAnalysisCategories } from "./analysis-repository";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  skillCategories,
  skillDefinitionCategories,
  skillDefinitions,
  skillVersionAnalysis,
  skillVersions,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import { setRegistryVisibility } from "../registry/review";
import { recordSkillMarketEvent } from "./events";
import { ensureListingProvenance } from "./provenance";
import {
  getSkillCategoryDefinition,
  skillCategoryDefinitions,
  skillCategoryId,
} from "./taxonomy";

/**
 * Putting a skill on the public market and taking it off again.
 *
 * `listSkillPublicly` is the one way a skill is listed: the admin action and
 * the scheduler's auto-listing pass both go through it, so a listed skill
 * always has its `listed_at`; categories arrive with AI analysis.
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
 * and must not move). Categories remain pending until AI analysis; existing
 * categories and administrator corrections survive re-listing.
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

    // New listings remain unclassified until AI analysis succeeds. Existing
    // categories (including manual corrections) survive relisting.
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

/** Explicitly return to AI-owned categories; hidden overview text is unrelated. */
export async function reinferSkillCategories(input: {
  skillId: string;
  actorUserId: string;
}): Promise<{ skillId: string; categorySlugs: string[] } | null> {
  const modelKey = await currentSkillAnalysisModelKey();
  return db.transaction(async (tx) => {
    const definition = await lockDefinition(tx, input.skillId);
    if (!definition) return null;
    const [result] = await tx
      .select({
        versionId: skillVersions.id,
        classification: skillVersionAnalysis.classification,
      })
      .from(skillVersions)
      .innerJoin(
        skillVersionAnalysis,
        eq(skillVersionAnalysis.skillVersionId, skillVersions.id),
      )
      .where(
        and(
          eq(skillVersions.skillId, input.skillId),
          eq(skillVersions.isCurrent, true),
          eq(skillVersionAnalysis.status, "ready"),
          eq(skillVersionAnalysis.promptVersion, SKILL_ANALYSIS_PROMPT_VERSION),
          eq(
            skillVersionAnalysis.taxonomyVersion,
            SKILL_ANALYSIS_TAXONOMY_VERSION,
          ),
          modelKey
            ? eq(skillVersionAnalysis.modelConfigurationKey, modelKey)
            : sql`false`,
        ),
      );
    if (!result?.classification || result.classification.status !== "ready") {
      throw new ContentError(
        409,
        "SKILL_ANALYSIS_REQUIRED",
        "Generate a valid AI analysis before applying categories",
      );
    }
    await applyAnalysisCategories(
      tx,
      input.skillId,
      result.versionId,
      result.classification,
      input.actorUserId,
    );
    return {
      skillId: input.skillId,
      categorySlugs: await categorySlugsIn(tx, input.skillId),
    };
  });
}

export const REINFER_CATEGORIES_BATCH_SIZE = 200;

/** Apply existing AI results in bounded transactions; no keyword fallback. */
export async function reinferAllSkillCategories(input: {
  actorUserId: string;
  batchSize?: number;
  onlySkillIds?: string[];
}): Promise<{ considered: number; changed: number }> {
  if (!(await skillAnalysisQualityApproved()))
    throw new ContentError(
      409,
      "SKILL_ANALYSIS_QUALITY_REQUIRED",
      "Complete the reviewed accuracy evaluation before bulk migration",
    );
  const modelKey = await currentSkillAnalysisModelKey();
  const tally = { considered: 0, changed: 0 };
  let afterId: string | null = null;
  const limit = Math.max(
    1,
    Math.min(input.batchSize ?? REINFER_CATEGORIES_BATCH_SIZE, 200),
  );
  for (;;) {
    const rows = await db
      .select({ id: skillDefinitions.id, versionId: skillVersions.id })
      .from(skillDefinitions)
      .innerJoin(
        skillVersions,
        and(
          eq(skillVersions.skillId, skillDefinitions.id),
          eq(skillVersions.isCurrent, true),
        ),
      )
      .innerJoin(
        skillVersionAnalysis,
        eq(skillVersionAnalysis.skillVersionId, skillVersions.id),
      )
      .where(
        and(
          eq(skillDefinitions.sourceType, "registry_github"),
          eq(skillDefinitions.status, "active"),
          sql`${skillDefinitions.categoriesSetBy} is distinct from 'admin'`,
          eq(skillVersionAnalysis.status, "ready"),
          eq(skillVersionAnalysis.promptVersion, SKILL_ANALYSIS_PROMPT_VERSION),
          eq(
            skillVersionAnalysis.taxonomyVersion,
            SKILL_ANALYSIS_TAXONOMY_VERSION,
          ),
          modelKey
            ? eq(skillVersionAnalysis.modelConfigurationKey, modelKey)
            : sql`false`,
          afterId ? sql`${skillDefinitions.id} > ${afterId}` : undefined,
          input.onlySkillIds
            ? inArray(skillDefinitions.id, input.onlySkillIds)
            : undefined,
        ),
      )
      .orderBy(skillDefinitions.id)
      .limit(limit);
    if (!rows.length) break;
    for (const row of rows) {
      tally.considered++;
      const changed = await db.transaction(async (tx) => {
        const definition = await lockDefinition(tx, row.id);
        if (!definition || definition.categoriesSetBy === "admin") return false;
        const [result] = await tx
          .select()
          .from(skillVersionAnalysis)
          .where(
            and(
              eq(skillVersionAnalysis.skillVersionId, row.versionId),
              eq(skillVersionAnalysis.status, "ready"),
              eq(
                skillVersionAnalysis.promptVersion,
                SKILL_ANALYSIS_PROMPT_VERSION,
              ),
              eq(
                skillVersionAnalysis.taxonomyVersion,
                SKILL_ANALYSIS_TAXONOMY_VERSION,
              ),
              modelKey
                ? eq(skillVersionAnalysis.modelConfigurationKey, modelKey)
                : sql`false`,
            ),
          );
        return result?.classification
          ? applyAnalysisCategories(
              tx,
              row.id,
              row.versionId,
              result.classification,
            )
          : false;
      });
      if (changed) tally.changed++;
    }
    afterId = rows.at(-1)!.id;
    if (rows.length < limit) break;
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
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillDefinitionCategories.skillId),
    )
    .leftJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
      ),
    )
    .leftJoin(
      skillVersionAnalysis,
      eq(skillVersionAnalysis.skillVersionId, skillVersions.id),
    )
    .where(inArray(skillDefinitionCategories.skillId, skillIds))
    .orderBy(
      sql`case when ${skillDefinitions.categoriesSetBy} = 'ai' and ${skillCategories.slug} = ${skillVersionAnalysis.classification}->>'primary' then 0 else 1 end`,
      skillCategories.sortOrder,
    );
  for (const row of rows) {
    const slugs = result.get(row.skillId) ?? [];
    slugs.push(row.slug);
    result.set(row.skillId, slugs);
  }
  return result;
}
