/**
 * The persistent, shared state behind the icon dry-run's fetches (Issue #367).
 * Every fetch scope — `site:<domain>` for an official site, `url:<hash>` for a
 * declared image — has one row that all workers and listings share:
 *
 * - a LEASE, so two workers (or two listings on one page) never fetch the same
 *   domain at once; a lease that is not settled expires;
 * - the cached OUTCOME, served until `nextAttemptAt`: 30 days after a success
 *   (or a definite refusal: robots, parked, challenge), and a bounded
 *   exponential backoff after an error or a deferral — 6 h doubling to 7 days.
 */

export type FetchScopeStatus = "ok" | "denied" | "deferred" | "error";

export type FetchStateRow = {
  scope: string;
  status: FetchScopeStatus;
  resultJson: Record<string, unknown> | null;
  errorCount: number;
  fetchedAt: Date | null;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
};

export interface IconStateStore {
  read(scope: string): Promise<FetchStateRow | null>;
  /** Takes the lease when the scope is due and not leased; false otherwise. */
  acquireLease(
    scope: string,
    owner: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean>;
  /** Writes the outcome and releases the lease `owner` holds. */
  settle(
    scope: string,
    owner: string,
    outcome: {
      status: FetchScopeStatus;
      resultJson: Record<string, unknown> | null;
      errorCount: number;
      fetchedAt: Date;
      nextAttemptAt: Date;
    },
  ): Promise<void>;
  recordHashDomain(input: { sha256: string; domain: string }): Promise<void>;
  /** Distinct registrable domains that served the image. */
  countHashDomains(sha256: string): Promise<number>;
}

export const ICON_SUCCESS_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const ICON_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
export const ICON_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const ICON_LEASE_MS = 2 * 60 * 1000;
/** Failures counted: beyond this the delay is already at its ceiling. */
export const ICON_MAX_ERROR_COUNT = 8;

/** When the scope may be tried again, and its new consecutive-failure count. */
export function nextIconAttempt(
  status: FetchScopeStatus,
  previousErrorCount: number,
  now: Date,
): { nextAttemptAt: Date; errorCount: number } {
  if (status === "ok" || status === "denied") {
    return {
      nextAttemptAt: new Date(now.getTime() + ICON_SUCCESS_REFRESH_MS),
      errorCount: 0,
    };
  }
  const errorCount = Math.min(previousErrorCount + 1, ICON_MAX_ERROR_COUNT);
  const delay = Math.min(
    ICON_BACKOFF_BASE_MS * 2 ** (errorCount - 1),
    ICON_BACKOFF_MAX_MS,
  );
  return { nextAttemptAt: new Date(now.getTime() + delay), errorCount };
}

export type ScopeOutcome<T> = { status: FetchScopeStatus; result?: T };

export type ScopeResult<T> =
  | {
      kind: "cached" | "fetched";
      status: FetchScopeStatus;
      result: T | undefined;
    }
  /** Another worker holds the lease: nothing fetched, nothing recorded. */
  | { kind: "busy" };

/**
 * Serves `scope` from its cached outcome while that is current, else takes
 * the lease, runs `fetch`, and records its outcome for every other worker. A
 * `fetch` that throws is an `error` outcome.
 */
export async function withIconScope<T extends Record<string, unknown>>(
  store: IconStateStore,
  scope: string,
  options: {
    owner: string;
    now: Date;
    leaseMs?: number;
    /**
     * A second scope whose lease is held while `fetch` runs, so scopes that
     * hit one registrable domain (two hosts of one site) never run at once.
     * It holds no outcome of its own and is due again as soon as it is freed.
     */
    lockScope?: string;
  },
  fetch: () => Promise<ScopeOutcome<T>>,
): Promise<ScopeResult<T>> {
  const { owner, now } = options;
  const row = await store.read(scope);
  if (row && row.nextAttemptAt.getTime() > now.getTime() && row.fetchedAt) {
    return {
      kind: "cached",
      status: row.status,
      result: (row.resultJson as T | null) ?? undefined,
    };
  }
  const leased = await store.acquireLease(
    scope,
    owner,
    now,
    options.leaseMs ?? ICON_LEASE_MS,
  );
  if (!leased) return { kind: "busy" };
  const leaseMs = options.leaseMs ?? ICON_LEASE_MS;
  if (options.lockScope) {
    const locked = await store.acquireLease(options.lockScope, owner, now, leaseMs);
    if (!locked) {
      // Free our own scope again, due at once, without recording an outcome.
      await store.settle(scope, owner, {
        status: row?.status ?? "deferred",
        resultJson: row?.resultJson ?? null,
        errorCount: row?.errorCount ?? 0,
        fetchedAt: row?.fetchedAt ?? now,
        nextAttemptAt: row?.nextAttemptAt ?? now,
      });
      return { kind: "busy" };
    }
  }
  let outcome: ScopeOutcome<T>;
  try {
    outcome = await fetch();
  } catch {
    outcome = { status: "error" };
  } finally {
    if (options.lockScope) {
      await store.settle(options.lockScope, owner, {
        status: "ok",
        resultJson: null,
        errorCount: 0,
        fetchedAt: now,
        nextAttemptAt: now,
      });
    }
  }
  const { nextAttemptAt, errorCount } = nextIconAttempt(
    outcome.status,
    row?.errorCount ?? 0,
    now,
  );
  await store.settle(scope, owner, {
    status: outcome.status,
    resultJson: outcome.result ?? null,
    errorCount,
    fetchedAt: now,
    nextAttemptAt,
  });
  return { kind: "fetched", status: outcome.status, result: outcome.result };
}

/** In-memory store: tests, and the report script's dry local runs. */
export function createMemoryIconStateStore(): IconStateStore & {
  rows: Map<string, FetchStateRow>;
} {
  const rows = new Map<string, FetchStateRow>();
  const hashes = new Map<string, Set<string>>();
  return {
    rows,
    async read(scope) {
      const row = rows.get(scope);
      return row ? { ...row } : null;
    },
    async acquireLease(scope, owner, now, leaseMs) {
      const row = rows.get(scope);
      if (row) {
        const leased = row.leaseUntil && row.leaseUntil.getTime() > now.getTime();
        if (row.nextAttemptAt.getTime() > now.getTime() || leased) return false;
        row.leaseOwner = owner;
        row.leaseUntil = new Date(now.getTime() + leaseMs);
        return true;
      }
      rows.set(scope, {
        scope,
        status: "deferred",
        resultJson: null,
        errorCount: 0,
        fetchedAt: null,
        nextAttemptAt: now,
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + leaseMs),
      });
      return true;
    },
    async settle(scope, owner, outcome) {
      const row = rows.get(scope);
      if (!row || row.leaseOwner !== owner) return;
      Object.assign(row, outcome, { leaseOwner: null, leaseUntil: null });
    },
    async recordHashDomain({ sha256, domain }) {
      const domains = hashes.get(sha256) ?? new Set<string>();
      domains.add(domain);
      hashes.set(sha256, domains);
    },
    async countHashDomains(sha256) {
      return hashes.get(sha256)?.size ?? 0;
    },
  };
}
