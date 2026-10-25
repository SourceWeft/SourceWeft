import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import { findStoredIconProvenance } from "../ingest/repository";
import { addIconDryRunCounts, emptyIconDryRunCounts, runIconDryRun, type IconDryRunCounts, type IconDryRunTarget } from "./icon-dry-run";
import { findClaimedDomains } from "./icon-dry-run-repository";
import { iconStateStore } from "./icon-state-repository";
import { canStoreMcpIcons, storeHashedMcpIcon } from "./store";

/**
 * The federation sync's icon dry-run step (Issue #367): runs after the logo
 * chain, per registry page, and only ever adds `iconCandidates` and
 * `iconDecision` to the versions' provenance. A failure is logged and counted,
 * never thrown; a version the step did not reach keeps the record it had.
 */

export type IconDryRunEntry = IconDryRunTarget;

export type IconDryRunProvenance = {
  iconCandidates?: unknown;
  iconDecision?: unknown;
};

export async function registryIconDryRun(
  entries: IconDryRunEntry[],
  now: Date,
): Promise<{ provenance: Map<string, IconDryRunProvenance>; counts: IconDryRunCounts }> {
  const provenance = new Map<string, IconDryRunProvenance>();
  const counts = emptyIconDryRunCounts();
  counts.entries = entries.length;
  if (entries.length === 0) return { provenance, counts };
  let stored: Awaited<ReturnType<typeof findStoredIconProvenance>> = new Map();
  try {
    stored = await findStoredIconProvenance(entries.map((e) => e.key));
    for (const entry of entries) {
      const previous = stored.get(entry.key);
      if (previous?.iconCandidates || previous?.iconDecision) {
        provenance.set(entry.key, {
          iconCandidates: previous.iconCandidates,
          iconDecision: previous.iconDecision,
        });
      }
    }
    if (!canStoreMcpIcons()) {
      // The public bucket is the only place a candidate may be stored; there
      // is no hotlink fallback.
      counts.skipped = entries.length;
      logger.warn("Registry federation: no public storage configured; icon dry-run skipped", {
        entries: entries.length,
      });
      return { provenance, counts };
    }
    const claimed = await findClaimedDomains(entries.map((e) => e.identifier));
    const run = await runIconDryRun(
      entries.map((entry) => ({
        ...entry,
        claimedDomains: claimed.get(entry.identifier),
      })),
      stored,
      {
        state: iconStateStore,
        store: storeHashedMcpIcon,
        ownStorageHost: new URL(config.publicS3.baseUrl).hostname.toLowerCase(),
        now,
      },
    );
    addIconDryRunCounts(counts, run.counts);
    counts.entries = entries.length;
    for (const [key, result] of run.results) {
      provenance.set(key, {
        iconCandidates: result.candidates,
        iconDecision: result.decision,
      });
    }
  } catch (error) {
    counts.failed = entries.length;
    logger.warn("Registry federation icon dry-run failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { provenance, counts };
}
