import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, mcpServers } from "@sourceweft/db";
import { publisherMeta } from "../publisher";
import {
  brandOfDomain,
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

/** How many rows one page of a group's candidate scan returns. */
export const PRODUCT_GROUP_CANDIDATE_LIMIT = 200;

/**
 * How many candidate rows a group read scans at most across its pages, so a
 * brand the confirming rules reject almost everywhere cannot walk the whole
 * table. A bound on work, not on membership: the candidates are ordered as
 * members are shown and the read stops as soon as it has the members it
 * shows.
 */
export const PRODUCT_GROUP_SCAN_LIMIT = 2_000;

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

/**
 * The publisher domains whose brand is `query` — the domains of the official
 * servers (see `findOfficialProductEntries`) that a search for the bare brand
 * means: "notion" → `notion.com`. Empty when the query names no official
 * brand. Brand derivation is `brandOfDomain`'s, the grouping module's own.
 */
export async function findBrandPublisherDomains(
  query: string,
): Promise<string[]> {
  const brand = query.trim().toLowerCase();
  if (!brand) {
    return [];
  }
  const officials = await findOfficialProductEntries();
  const domains = new Set<string>();
  for (const official of officials) {
    const domain = official.publisher?.domain;
    if (domain && brandOfDomain(domain) === brand) {
      domains.add(domain);
    }
  }
  return [...domains];
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The pattern for one token, matching either case: `[Nn][Oo][Tt]…`. */
function caseInsensitiveToken(token: string) {
  return [...token]
    .map((character) => {
      const upper = character.toUpperCase();
      const escaped = /[\p{L}\p{N}]/u.test(character)
        ? character
        : `\\${character}`;
      return upper.length === 1 && upper !== character
        ? `[${character}${upper}]`
        : escaped;
    })
    .join("");
}

// A token starts after a character that is not a letter or digit (or at the
// start), at a lower-to-upper step ("myNotion"), or inside an acronym run
// ("MCPNotion"): the places `slugTokens` splits.
const TOKEN_START =
  "(?:(?<![[:alnum:]])|(?<=[[:lower:][:digit:]])(?=[[:upper:]])|(?<=[[:upper:]])(?=[[:upper:]][[:lower:]]))";
// ... and ends before a character that is not a letter or digit (or at the
// end), at a lower-to-upper step ("NotionMCP") or at the end of an acronym
// run ("NOTIONMcp"). Followed by a lowercase letter or a digit it does not
// end: "notionally", "notion2" are single tokens.
const TOKEN_END =
  "(?:(?![[:alnum:]])|(?<=[[:lower:][:digit:]])(?=[[:upper:]])|(?<=[[:upper:]])(?=[[:upper:]][[:lower:]]))";

/**
 * A PostgreSQL regular expression for text that carries `brandTokens` as
 * whole consecutive tokens, mirroring `slugTokens` closely enough to be a
 * superset of `entryCarriesBrand` (it ignores the case of the brand but not
 * the case of the text, which is where camelCase boundaries live). Built
 * from the brand's letters and digits only and passed as a parameter, never
 * written into the SQL text.
 */
export function brandTokenPattern(brandTokens: readonly string[]): string {
  return `${TOKEN_START}${brandTokens
    .map(caseInsensitiveToken)
    .join("[^[:alnum:]]*")}${TOKEN_END}`;
}

// The identifier tail, as `identifierTail` reads it: after the first slash.
const identifierTailSql = sql`substr(${mcpServers.identifier}, strpos(${mcpServers.identifier}, '/') + 1)`;

/**
 * One page of the public servers that may belong to `group`, by a cheap
 * superset of the membership rules: the brand as whole tokens in the name or
 * the identifier tail, the group's domain as publisher, the official
 * server's repository owner as namespace account or repository owner, and
 * the official server itself. Ordered as members are shown: the official
 * server, other servers whose publisher runs their endpoint, then newest
 * first. So the page boundary never drops an official server, and the first
 * confirmed members are the ones a group displays.
 */
export async function findProductGroupCandidateRows(
  group: ProductGroupKey,
  page: { limit?: number; offset?: number } = {},
): Promise<ServerRow[]> {
  const tokens =
    group.brandTokens.length > 0 ? group.brandTokens : [group.brand];
  const pattern = brandTokenPattern(tokens);
  const matches = [
    sql`${mcpServers.name} ~ ${pattern}`,
    sql`${identifierTailSql} ~ ${pattern}`,
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
      sql`(case when ${endpointMatchStored} then 0 else 1 end)`,
      sql`${mcpServers.publishedAt} desc nulls last`,
      desc(mcpServers.id),
    )
    .limit(page.limit ?? PRODUCT_GROUP_CANDIDATE_LIMIT)
    .offset(page.offset ?? 0);
}

/**
 * The product group `row` belongs to and its member rows in display order,
 * capped at `PRODUCT_GROUP_MEMBER_LIMIT`; null when no official server exists
 * for the server's brand. Each member is a server whose own page names this
 * group, so the list and the pages agree. The cap bounds the list, not
 * membership: candidates are read page by page, in display order, until the
 * list is full, the candidates run out, or `PRODUCT_GROUP_SCAN_LIMIT` rows
 * have been scanned.
 */
export async function findProductGroupMembers(
  row: ServerRow,
  options: { pageSize?: number } = {},
): Promise<{ group: ProductGroupKey; rows: ServerRow[] } | null> {
  const officials = await findOfficialProductEntries();
  const group = productGroupFor(productGroupEntryOf(row), officials);
  if (!group) {
    return null;
  }
  const pageSize = options.pageSize ?? PRODUCT_GROUP_CANDIDATE_LIMIT;
  const rows: ServerRow[] = [];
  for (
    let offset = 0;
    offset < PRODUCT_GROUP_SCAN_LIMIT &&
    rows.length < PRODUCT_GROUP_MEMBER_LIMIT;
    offset += pageSize
  ) {
    const candidates = await findProductGroupCandidateRows(group, {
      limit: pageSize,
      offset,
    });
    rows.push(
      ...candidates.filter((candidate) =>
        isProductGroupMember(group, productGroupEntryOf(candidate), officials),
      ),
    );
    if (candidates.length < pageSize) {
      break;
    }
  }
  rows.sort((left, right) =>
    compareProductGroupMembers(group)(
      productGroupEntryOf(left),
      productGroupEntryOf(right),
    ),
  );
  return { group, rows: rows.slice(0, PRODUCT_GROUP_MEMBER_LIMIT) };
}
