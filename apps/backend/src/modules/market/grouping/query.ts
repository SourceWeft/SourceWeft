import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, mcpServers } from "@sourceweft/db";
import { publisherMeta } from "../publisher";
import {
  compareProductGroupMembers,
  isProductGroupMember,
  productGroupFor,
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
 * a read instead: one for the official servers, which every grouped detail
 * needs and which is remembered for a minute, and one for the candidates of
 * the one group the server belongs to. The SQL filters are supersets of the
 * pure rules in `product-group.ts`, which confirm each candidate.
 */

type ServerRow = typeof mcpServers.$inferSelect;

/** How many rows one group's candidate scan returns at most. */
export const PRODUCT_GROUP_CANDIDATE_LIMIT = 200;

/** How many members a group exposes at most, the official server always among them. */
export const PRODUCT_GROUP_MEMBER_LIMIT = 50;

/**
 * How long the official-server list is reused. It changes only when a sync
 * writes a publisher, and the public detail is cached for as long again.
 */
export const OFFICIAL_ENTRIES_TTL_MS = 60_000;

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
    publisher: publisherMeta(row.metadataJson),
  };
}

// The flag as text, not a cast: a stray value in the path must not turn
// every grouped read into a 500.
const endpointMatchStored = sql`${mcpServers.metadataJson} #>> '{publisher,endpointMatch}' = 'true'`;

/**
 * Every public server whose publisher runs its endpoint — the servers that can
 * anchor a group. A short list (one per product), read without an index: the
 * flag lives in the promoted metadata.
 */
export async function readOfficialProductEntries(): Promise<
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
    .where(and(publicCondition(), endpointMatchStored));
  return rows.map(productGroupEntryOf);
}

let officialEntries: {
  readAt: number;
  entries: Promise<ProductGroupEntry[]>;
} | null = null;

/**
 * The official servers, remembered for `OFFICIAL_ENTRIES_TTL_MS` across
 * reads in this process. A failed read is not remembered.
 */
export function findOfficialProductEntries(
  now = Date.now(),
): Promise<ProductGroupEntry[]> {
  if (
    !officialEntries ||
    now - officialEntries.readAt >= OFFICIAL_ENTRIES_TTL_MS
  ) {
    const entries = readOfficialProductEntries();
    officialEntries = { readAt: now, entries };
    entries.catch(() => {
      if (officialEntries?.entries === entries) {
        officialEntries = null;
      }
    });
  }
  return officialEntries.entries;
}

/** Forget the remembered official servers (tests that write publishers). */
export function forgetOfficialProductEntries() {
  officialEntries = null;
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
 * for the server's brand. Each member is a server whose own page names this
 * group, so the list and the pages agree.
 */
export async function findProductGroupMembers(
  row: ServerRow,
): Promise<{ group: ProductGroupKey; rows: ServerRow[] } | null> {
  const officials = await findOfficialProductEntries();
  const group = productGroupFor(productGroupEntryOf(row), officials);
  if (!group) {
    return null;
  }
  const candidates = await findProductGroupCandidateRows(group);
  const rows = candidates
    .filter((candidate) =>
      isProductGroupMember(group, productGroupEntryOf(candidate), officials),
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
