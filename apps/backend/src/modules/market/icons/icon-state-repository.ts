import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  marketMcpIconFetchState,
  marketMcpIconHashDomains,
} from "@sourceweft/db";
import type { FetchStateRow, IconStateStore } from "./icon-state";

/** The Postgres-backed `IconStateStore` shared by every worker. */
export const iconStateStore: IconStateStore = {
  async read(scope) {
    const [row] = await db
      .select()
      .from(marketMcpIconFetchState)
      .where(eq(marketMcpIconFetchState.scope, scope))
      .limit(1);
    return (row as FetchStateRow | undefined) ?? null;
  },
  async acquireLease(scope, owner, now, leaseMs) {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    // One statement: a new scope is leased on insert; an existing one only
    // when it is due and no live lease holds it.
    const rows = await db
      .insert(marketMcpIconFetchState)
      .values({
        scope,
        status: "deferred",
        nextAttemptAt: now,
        leaseOwner: owner,
        leaseUntil,
      })
      .onConflictDoUpdate({
        target: marketMcpIconFetchState.scope,
        set: { leaseOwner: owner, leaseUntil },
        setWhere: and(
          lte(marketMcpIconFetchState.nextAttemptAt, now),
          or(
            isNull(marketMcpIconFetchState.leaseUntil),
            lte(marketMcpIconFetchState.leaseUntil, now),
          ),
        ),
      })
      .returning({ scope: marketMcpIconFetchState.scope });
    return rows.length > 0;
  },
  async settle(scope, owner, outcome) {
    await db
      .update(marketMcpIconFetchState)
      .set({ ...outcome, leaseOwner: null, leaseUntil: null })
      .where(
        and(
          eq(marketMcpIconFetchState.scope, scope),
          eq(marketMcpIconFetchState.leaseOwner, owner),
        ),
      );
  },
  async recordHashDomain({ sha256, domain, label }) {
    await db
      .insert(marketMcpIconHashDomains)
      .values({ sha256, domain, label })
      .onConflictDoNothing();
  },
  async countHashLabels(sha256) {
    const [row] = await db
      .select({
        count: sql<number>`count(distinct ${marketMcpIconHashDomains.label})::int`,
      })
      .from(marketMcpIconHashDomains)
      .where(eq(marketMcpIconHashDomains.sha256, sha256));
    return row?.count ?? 0;
  },
};
