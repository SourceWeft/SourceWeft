// Multi-site helpers shared by the Atlassian connectors: the fan-out cap, the
// site grouping and accessibility check, and the note that tells the agent which
// selected sites were skipped.

import type { AtlassianSite } from "./resources";

/** At most this many sites are contacted per call, in cloud-id ascending order. */
export const MAX_FANOUT_SITES = 5;

/** The upper bound on a cursor, matching the `cursor` field's `maxLength` in the
 * contribution input schemas. */
export const CURSOR_MAX_LENGTH = 4096;

/** The site's host (e.g. `example.atlassian.net`) for a selection entry's
 * `detail`. An unparseable `url` (the provider payload is not trusted) yields an
 * empty string rather than throwing. */
export function siteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Groups entries by cloud id, preserving each group's entry order, with the
 * keys in ascending cloud-id order: the order every multi-site fan-out iterates
 * sites in. */
export function groupBySite<T extends { cloudId: string }>(
  entries: readonly T[],
): Map<string, T[]> {
  const byCloudId = new Map<string, T[]>();
  for (const entry of entries) {
    const group = byCloudId.get(entry.cloudId);
    if (group) {
      group.push(entry);
    } else {
      byCloudId.set(entry.cloudId, [entry]);
    }
  }
  return new Map(
    [...byCloudId.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** One selected site kept for a call, with the value grouped under it. */
export type SelectedSite<V> = {
  cloudId: string;
  site: AtlassianSite;
  value: V;
};

/** Keeps the first {@link MAX_FANOUT_SITES} selected sites that are in `sites`
 * and pass `hasScope`, in the order of `grouped`. `inaccessible` lists selected
 * cloud ids that are not accessible (absent, or without the scope);
 * `overflowCount` counts accessible selected sites dropped by the cap. Pure: the
 * caller lists the sites and decides what an empty `kept` means. */
export function pickAccessibleSites<V>(input: {
  sites: readonly AtlassianSite[];
  grouped: ReadonlyMap<string, V>;
  hasScope: (site: AtlassianSite) => boolean;
}): { kept: SelectedSite<V>[]; inaccessible: string[]; overflowCount: number } {
  const accessible = new Map(
    input.sites
      .filter(input.hasScope)
      .map((site) => [site.cloudId, site] as const),
  );
  const kept: SelectedSite<V>[] = [];
  const inaccessible: string[] = [];
  let overflowCount = 0;
  for (const [cloudId, value] of input.grouped) {
    const site = accessible.get(cloudId);
    if (!site) {
      inaccessible.push(cloudId);
      continue;
    }
    if (kept.length >= MAX_FANOUT_SITES) {
      overflowCount += 1;
      continue;
    }
    kept.push({ cloudId, site, value });
  }
  return { kept, inaccessible, overflowCount };
}

/** Builds the sites note from the selected sites that could not be reached
 * (named, or by cloud id when the name is unknown) and the count of sites left
 * unsearched because of the fan-out cap. Either fact may be present; returns
 * `undefined` when nothing was dropped. */
export function buildSitesNote(
  unreachable: readonly string[],
  overflowCount: number,
): string | undefined {
  const facts: string[] = [];
  if (unreachable.length > 0) {
    const noun = unreachable.length === 1 ? "site" : "sites";
    facts.push(
      `${unreachable.length} selected ${noun} can no longer be accessed: ${unreachable.join(", ")}.`,
    );
  }
  if (overflowCount > 0) {
    facts.push(
      `Only the first ${MAX_FANOUT_SITES} selected sites are searched; ${overflowCount} more were not.`,
    );
  }
  return facts.length > 0 ? facts.join(" ") : undefined;
}
