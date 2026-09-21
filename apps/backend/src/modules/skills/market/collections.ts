import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type {
  CreateSkillCollectionRequest,
  SkillCollectionAdmin,
  UpdateSkillCollectionRequest,
} from "@sourceweft/contracts";
import type {
  GetMarketSkillCollectionResponse,
  ListMarketSkillCollectionsResponse,
  MarketSkillCollection,
} from "@sourceweft/market-contracts";
import {
  db,
  skillCollectionItems,
  skillCollections,
  skillDefinitions,
  skillVersions,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import {
  findMarketSkillSummariesByIds,
  publicMarketSkillCondition,
} from "./read-repository";

/**
 * Editorial collections on the public market: a market admin picks a title
 * and an ordered set of skills. The public side shows only published
 * collections, and inside one only the skills that are public right now — an
 * item is kept when its skill is withdrawn, so it comes back if the skill does,
 * but nobody sees it meanwhile.
 */

const orderCollections = [
  asc(skillCollections.position),
  asc(skillCollections.title),
  asc(skillCollections.id),
];

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Public skills per collection: the number its public page shows. */
async function countPublicItems(
  collectionIds: string[],
): Promise<Map<string, number>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await db
    .select({
      collectionId: skillCollectionItems.collectionId,
      count: count(),
    })
    .from(skillCollectionItems)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillCollectionItems.skillId),
    )
    .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
    .where(
      and(
        inArray(skillCollectionItems.collectionId, collectionIds),
        publicMarketSkillCondition(),
      ),
    )
    .groupBy(skillCollectionItems.collectionId);
  return new Map(rows.map((row) => [row.collectionId, Number(row.count)]));
}

function publicCollection(
  row: typeof skillCollections.$inferSelect,
  itemCount: number,
): MarketSkillCollection {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    itemCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPublicSkillCollections(): Promise<ListMarketSkillCollectionsResponse> {
  const rows = await db
    .select()
    .from(skillCollections)
    .where(eq(skillCollections.published, true))
    .orderBy(...orderCollections);
  const counts = await countPublicItems(rows.map((row) => row.id));
  return {
    items: rows.map((row) => publicCollection(row, counts.get(row.id) ?? 0)),
  };
}

/** null for a slug that is not a published collection. */
export async function findPublicSkillCollection(
  slug: string,
): Promise<GetMarketSkillCollectionResponse | null> {
  const [row] = await db
    .select()
    .from(skillCollections)
    .where(
      and(eq(skillCollections.slug, slug), eq(skillCollections.published, true)),
    )
    .limit(1);
  if (!row) return null;
  const items = await db
    .select({ skillId: skillCollectionItems.skillId })
    .from(skillCollectionItems)
    .where(eq(skillCollectionItems.collectionId, row.id))
    .orderBy(asc(skillCollectionItems.position), asc(skillCollectionItems.skillId));
  // Only public skills come back from here, in the order asked for.
  const summaries = await findMarketSkillSummariesByIds(
    items.map((item) => item.skillId),
  );
  return {
    collection: publicCollection(row, summaries.length),
    items: summaries.map(({ id: _id, ...summary }) => summary),
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function adminItems(
  collectionIds: string[],
): Promise<Map<string, SkillCollectionAdmin["items"]>> {
  const byCollection = new Map<string, SkillCollectionAdmin["items"]>();
  if (collectionIds.length === 0) return byCollection;
  const rows = await db
    .select({
      collectionId: skillCollectionItems.collectionId,
      skillId: skillCollectionItems.skillId,
      position: skillCollectionItems.position,
      slug: skillDefinitions.slug,
      displayName: skillDefinitions.displayName,
      // The same question the public page asks, per item.
      public: sql<boolean>`exists (
        select 1 from ${skillVersions}
        where ${skillVersions.skillId} = ${skillDefinitions.id}
          and ${publicMarketSkillCondition()}
      )`,
    })
    .from(skillCollectionItems)
    .innerJoin(
      skillDefinitions,
      eq(skillDefinitions.id, skillCollectionItems.skillId),
    )
    .where(inArray(skillCollectionItems.collectionId, collectionIds))
    .orderBy(asc(skillCollectionItems.position), asc(skillCollectionItems.skillId));
  for (const row of rows) {
    const list = byCollection.get(row.collectionId) ?? [];
    list.push({
      skillId: row.skillId,
      slug: row.slug,
      displayName: row.displayName,
      position: row.position,
      public: row.public === true,
    });
    byCollection.set(row.collectionId, list);
  }
  return byCollection;
}

function adminCollection(
  row: typeof skillCollections.$inferSelect,
  items: SkillCollectionAdmin["items"],
): SkillCollectionAdmin {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    position: row.position,
    published: row.published,
    items,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSkillCollectionsForAdmin(): Promise<
  SkillCollectionAdmin[]
> {
  const rows = await db
    .select()
    .from(skillCollections)
    .orderBy(...orderCollections);
  const items = await adminItems(rows.map((row) => row.id));
  return rows.map((row) => adminCollection(row, items.get(row.id) ?? []));
}

export async function getSkillCollectionForAdmin(
  id: string,
): Promise<SkillCollectionAdmin | null> {
  const [row] = await db
    .select()
    .from(skillCollections)
    .where(eq(skillCollections.id, id))
    .limit(1);
  if (!row) return null;
  return adminCollection(row, (await adminItems([row.id])).get(row.id) ?? []);
}

export async function createSkillCollection(
  input: CreateSkillCollectionRequest,
): Promise<SkillCollectionAdmin> {
  const id = randomUUID();
  const [row] = await db
    .insert(skillCollections)
    .values({
      id,
      slug: input.slug,
      title: input.title,
      summary: input.summary ?? "",
      position: input.position ?? 0,
      published: input.published ?? false,
    })
    .onConflictDoNothing({ target: skillCollections.slug })
    .returning();
  if (!row) {
    throw new ContentError(
      409,
      "SKILL_COLLECTION_SLUG_TAKEN",
      `A collection called '${input.slug}' already exists`,
    );
  }
  return adminCollection(row, []);
}

export async function updateSkillCollection(
  id: string,
  input: UpdateSkillCollectionRequest,
): Promise<SkillCollectionAdmin | null> {
  const [row] = await db
    .update(skillCollections)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(skillCollections.id, id))
    .returning({ id: skillCollections.id });
  return row ? getSkillCollectionForAdmin(row.id) : null;
}

export async function deleteSkillCollection(id: string): Promise<boolean> {
  // Its items go with it (`on delete cascade`).
  const rows = await db
    .delete(skillCollections)
    .where(eq(skillCollections.id, id))
    .returning({ id: skillCollections.id });
  return rows.length > 0;
}

/**
 * Replaces the collection's skills with these, in this order. Any community
 * or other non-builtin skill may be named — a withdrawn one is kept but not
 * shown — and an unknown slug fails the whole call, naming it, rather than
 * saving a list with a hole where the admin thought a skill was.
 */
export async function setSkillCollectionItems(
  id: string,
  slugs: readonly string[],
): Promise<SkillCollectionAdmin | null> {
  const unique = [...new Set(slugs)];
  return db.transaction(async (tx) => {
    const [collection] = await tx
      .select({ id: skillCollections.id })
      .from(skillCollections)
      .where(eq(skillCollections.id, id))
      .limit(1)
      .for("update");
    if (!collection) return null;
    const skills =
      unique.length === 0
        ? []
        : await tx
            .select({ id: skillDefinitions.id, slug: skillDefinitions.slug })
            .from(skillDefinitions)
            .where(
              and(
                inArray(skillDefinitions.slug, unique),
                sql`${skillDefinitions.sourceType} <> 'builtin'`,
              ),
            );
    const bySlug = new Map(skills.map((skill) => [skill.slug, skill.id]));
    const missing = unique.filter((slug) => !bySlug.has(slug));
    if (missing.length > 0) {
      throw new ContentError(
        400,
        "SKILL_COLLECTION_UNKNOWN_SKILL",
        `No such skill: ${missing.join(", ")}`,
        { details: { slugs: missing } },
      );
    }
    await tx
      .delete(skillCollectionItems)
      .where(eq(skillCollectionItems.collectionId, id));
    if (unique.length > 0) {
      await tx.insert(skillCollectionItems).values(
        unique.map((slug, position) => ({
          collectionId: id,
          skillId: bySlug.get(slug)!,
          position,
        })),
      );
    }
    await tx
      .update(skillCollections)
      .set({ updatedAt: new Date() })
      .where(eq(skillCollections.id, id));
    return true;
  }).then((done) => (done ? getSkillCollectionForAdmin(id) : null));
}
