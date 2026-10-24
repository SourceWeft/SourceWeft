import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, mcpServers } from "@sourceweft/db";
import {
  compareProductGroupMembers,
  isProductGroupMember,
  productGroupFor,
  publisherOf,
  type ProductGroupEntry,
  type ProductGroupKey,
} from "./product-group";

/**
 * Catalog reads behind same-product grouping (Issue #367, W8).
 *
 * Membership is computed when a detail is read, not stored per row: a group
 * is a property of the whole catalog (the official server that anchors it
 * may be federated after its integrations), so a stored key would have to be
 * recomputed catalog-wide on every sync. Two scans of the server table serve
 * a read instead: one for the official servers, which every detail needs,
 * and one for the candidates of the one group the server belongs to. The
 * second runs only on grouped pages. The SQL filters are supersets of the
 * pure rules in `product-group.ts`, which confirm each candidate.
 */

type ServerRow = typeof mcpServers.$inferSelect;

/** How many rows one group's candidate scan returns at most. */
export const PRODUCT_GROUP_CANDIDATE_LIMIT = 200;

/** How many members a group exposes at most, the official server always among them. */
export const PRODUCT_GROUP_MEMBER_LIMIT = 50;

// The same public condition as `publicMarketMcpCondition` in the read
// repository, written here so that this module does not import the module
// that calls it.
function publicCondition() {
  return and(
    eq(mcpServers.status, "published"),
    eq(mcpServers.visibility, "public"),
  )!;
}

/** The grouping view of a server row. */
export function productGroupEntryOf(
  row: Pick<
    ServerRow,
    "id" | "identifier" | "name" | "repoUrl" | "publishedAt" | "metadataJson"
  >,
): ProductGroupEntry {
  return {
    id: row.id,
    identifier: row.identifier,
    name: row.name,
    repoUrl: row.repoUrl,
    publishedAt: row.publishedAt,
    publisher: publisherOf(row.metadataJson),
  };
}

/**
 * Every public server whose publisher runs its endpoint — the servers that can
 * anchor a group. A short list (one per product), read without an index: the
 * flag lives in the promoted metadata.
 */
export async function findOfficialProductEntries(): Promise<
  ProductGroupEntry[]
> {
  const rows = await db
    .select({
      id: mcpServers.id,
      identifier: mcpServers.identifier,
      name: mcpServers.name,
      repoUrl: mcpServers.repoUrl,
      publishedAt: mcpServers.publishedAt,
      metadataJson: mcpServers.metadataJson,
    })
    .from(mcpServers)
    .where(
      and(
        publicCondition(),
        sql`(${mcpServers.metadataJson} #>> '{publisher,endpointMatch}')::boolean`,
      ),
    );
  return rows.map(productGroupEntryOf);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The public servers that may belong to `group`, by a cheap superset of the
 * membership rules: the brand's first token anywhere in the name or
 * identifier, the group's domain as publisher, the official server's
 * repository owner as namespace account or repository owner, and the official
 * server itself. Ordered as members are shown, the official server first, so
 * the cap never drops it.
 */
export async function findProductGroupCandidateRows(
  group: ProductGroupKey,
): Promise<ServerRow[]> {
  const firstToken = group.brandTokens[0] ?? group.brand;
  const matches = [
    sql`strpos(lower(${mcpServers.name}), ${firstToken}) > 0`,
    sql`strpos(lower(${mcpServers.identifier}), ${firstToken}) > 0`,
    sql`${mcpServers.metadataJson} #>> '{publisher,domain}' = ${group.domain}`,
    eq(mcpServers.identifier, group.officialIdentifier),
  ];
  if (group.repoOwner) {
    const owner = escapeLike(group.repoOwner);
    matches.push(
      sql`lower(${mcpServers.identifier}) like ${`io.github.${owner}/%`}`,
      sql`lower(${mcpServers.repoUrl}) like ${`%github.com/${owner}/%`}`,
    );
  }
  const pinned = sql<number>`(case when ${mcpServers.identifier} = ${group.officialIdentifier} then 0 else 1 end)`;
  return db
    .select()
    .from(mcpServers)
    .where(and(publicCondition(), or(...matches)))
    .orderBy(
      pinned,
      sql`${mcpServers.publishedAt} desc nulls last`,
      desc(mcpServers.id),
    )
    .limit(PRODUCT_GROUP_CANDIDATE_LIMIT);
}

/**
 * The product group `row` belongs to and its member rows in display order,
 * capped at `PRODUCT_GROUP_MEMBER_LIMIT`; null when no official server exists
 * for the server's brand.
 */
export async function findProductGroupMembers(
  row: ServerRow,
): Promise<{ group: ProductGroupKey; rows: ServerRow[] } | null> {
  const group = productGroupFor(
    productGroupEntryOf(row),
    await findOfficialProductEntries(),
  );
  if (!group) {
    return null;
  }
  const candidates = await findProductGroupCandidateRows(group);
  const rows = candidates
    .filter((candidate) =>
      isProductGroupMember(group, productGroupEntryOf(candidate)),
    )
    .sort((left, right) =>
      compareProductGroupMembers(group)(
        productGroupEntryOf(left),
        productGroupEntryOf(right),
      ),
    )
    .slice(0, PRODUCT_GROUP_MEMBER_LIMIT);
  return { group, rows };
}
