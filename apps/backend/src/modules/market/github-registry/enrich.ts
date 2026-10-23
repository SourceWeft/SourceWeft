import type { MarketMcpGithubRegistryMatch } from "@sourceweft/market-contracts";
import { logger } from "../../../shared/logger";
import { genericFallbackName } from "../federation";
import {
  fetchGithubRegistryServers,
  type GithubRegistryFetchResult,
  type GithubRegistryFetchStop,
  type GithubRegistryRow,
} from "./fetch";
import {
  githubRegistryManifestPatch,
  githubRegistryRecord,
  type GithubRegistryManifestPatch,
} from "./manifest";
import { matchGithubRegistryRow, urlHost } from "./match";
import {
  listGithubRegistryTargets,
  writeGithubRegistryMatch,
  type GithubRegistryTarget,
} from "./repository";

/**
 * One pass of the GitHub MCP Registry enrichment: read the registry, match
 * its rows to the catalog's federated entries (`match.ts`), and store on each
 * matched version what the row says about it (`manifest.ts`). Entries are
 * only ever annotated, never created: a row with no match is dropped. A pass
 * is idempotent — the same registry twice writes the same records, and the
 * manifest rules change nothing the second time — and a row that has gone
 * from the registry leaves its record in place with its `fetchedAt`.
 */

export type GithubRegistryPassSummary = {
  startedAt: string;
  finishedAt: string;
  /** Pages requested, and rows read from them. */
  pages: number;
  rows: number;
  /** Null when the walk reached the registry's last page. */
  stoppedBy: GithubRegistryFetchStop | null;
  error?: string;
  /** Catalog entries a row could annotate. */
  targets: number;
  matched: { name: number; endpointDomainOrg: number };
  /** Records written, and how many of them changed the manifest too. */
  written: number;
  manifestPatched: number;
  /** Matches whose write failed; the next pass tries them again. */
  failed: number;
};

export type GithubRegistryEnrichmentDeps = {
  fetchServers: () => Promise<GithubRegistryFetchResult>;
  listTargets: () => Promise<GithubRegistryTarget[]>;
  write: (input: {
    serverId: string;
    versionId: string;
    record: ReturnType<typeof githubRegistryRecord>;
    patch: GithubRegistryManifestPatch;
    now: Date;
  }) => Promise<void>;
  now: () => Date;
};

const defaultDeps: GithubRegistryEnrichmentDeps = {
  fetchServers: () => fetchGithubRegistryServers(),
  listTargets: listGithubRegistryTargets,
  write: writeGithubRegistryMatch,
  now: () => new Date(),
};

export type GithubRegistryMatchedTarget = {
  target: GithubRegistryTarget;
  row: GithubRegistryRow;
  matchedBy: MarketMcpGithubRegistryMatch;
};

/**
 * Every (target, row) pair the rules match, one row per target: a name match
 * beats an endpoint match, and among equals the first row read wins. Rows are
 * looked up by name and by remote host, so a pass is linear in rows plus
 * targets rather than their product.
 */
export function matchGithubRegistryRows(
  rows: GithubRegistryRow[],
  targets: GithubRegistryTarget[],
): GithubRegistryMatchedTarget[] {
  const byIdentifier = new Map<string, GithubRegistryTarget[]>();
  const byHost = new Map<string, GithubRegistryTarget[]>();
  for (const target of targets) {
    const sameName = byIdentifier.get(target.identifier) ?? [];
    sameName.push(target);
    byIdentifier.set(target.identifier, sameName);
    const host = urlHost(target.endpointUrl);
    if (host) {
      const sameHost = byHost.get(host) ?? [];
      sameHost.push(target);
      byHost.set(host, sameHost);
    }
  }

  const matched = new Map<string, GithubRegistryMatchedTarget>();
  const consider = (row: GithubRegistryRow, target: GithubRegistryTarget) => {
    const match = matchGithubRegistryRow(row, target);
    if (!match) return;
    const current = matched.get(target.versionId);
    if (
      current &&
      (current.matchedBy === "name" || match.matchedBy !== "name")
    ) {
      return;
    }
    matched.set(target.versionId, { target, row, matchedBy: match.matchedBy });
  };
  for (const row of rows) {
    for (const target of byIdentifier.get(row.name) ?? []) {
      consider(row, target);
    }
    const host = urlHost(row.remoteUrl);
    if (host) {
      for (const target of byHost.get(host) ?? []) {
        consider(row, target);
      }
    }
  }
  return [...matched.values()];
}

export async function runGithubRegistryEnrichment(
  deps: GithubRegistryEnrichmentDeps = defaultDeps,
): Promise<GithubRegistryPassSummary> {
  const startedAt = deps.now();
  const summary: GithubRegistryPassSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    pages: 0,
    rows: 0,
    stoppedBy: null,
    targets: 0,
    matched: { name: 0, endpointDomainOrg: 0 },
    written: 0,
    manifestPatched: 0,
    failed: 0,
  };

  const fetched = await deps.fetchServers();
  summary.pages = fetched.pages;
  summary.rows = fetched.rows.length;
  summary.stoppedBy = fetched.stoppedBy;
  if (fetched.error) summary.error = fetched.error;
  if (fetched.stoppedBy) {
    logger.warn("GitHub MCP Registry walk stopped early", {
      stoppedBy: fetched.stoppedBy,
      pages: fetched.pages,
      rows: fetched.rows.length,
      error: fetched.error,
    });
  }

  if (fetched.rows.length > 0) {
    const targets = await deps.listTargets();
    summary.targets = targets.length;
    const matches = matchGithubRegistryRows(fetched.rows, targets);
    for (const { target, row, matchedBy } of matches) {
      if (matchedBy === "name") summary.matched.name += 1;
      else summary.matched.endpointDomainOrg += 1;
      const now = deps.now();
      const record = githubRegistryRecord(row, matchedBy, now);
      const patch = githubRegistryManifestPatch(target, record, {
        fallbackName: genericFallbackName(target.identifier),
        untitled: target.untitled,
      });
      try {
        await deps.write({
          serverId: target.serverId,
          versionId: target.versionId,
          record,
          patch,
          now,
        });
        summary.written += 1;
        if (Object.keys(patch).length > 0) summary.manifestPatched += 1;
      } catch (error) {
        summary.failed += 1;
        logger.warn("GitHub MCP Registry match write failed", {
          identifier: target.identifier,
          row: row.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  summary.finishedAt = deps.now().toISOString();
  logger.info("GitHub MCP Registry pass complete", { ...summary });
  return summary;
}
