import { logger } from "../../../shared/logger";
import {
  iconBeforeFavicon,
  namespaceDomain,
  resolveIcon,
  type IconChainInput,
  type ResolvedIcon,
} from "./chain";
import { fetchFavicon, type FaviconService } from "./favicon";
import { canStoreMcpIcons, storeMcpIcon, type McpIconStore } from "./store";

/**
 * The icon step of a federation sync, run per registry page the way the auth
 * probe is: steps 1–3 of the chain need no network; a favicon is fetched only
 * for an entry they leave without a logo, once per namespace domain, through
 * the page's worker pool, and its outcome is cached in the version's
 * provenance as `iconProbe` so later syncs reuse it. A registry icon added
 * later wins on the next sync because the chain is evaluated every time.
 */

export type IconTarget = {
  /** The key the result is returned under (the version id). */
  key: string;
  identifier: string;
  registryIconUrl?: string;
  repositoryUrl?: string;
};

/** The sibling-written provenance the chain reads, each absent until it is. */
export type StoredIconProvenance = {
  selfDescription?: unknown;
  githubRegistry?: unknown;
  iconProbe?: unknown;
};

/**
 * The favicon fetch as kept in provenance. A hit keeps our stored URL and
 * which service answered; a miss is retried after 30 days; both are dropped
 * when the namespace domain changes.
 */
export type IconProbeRecord = {
  domain: string;
  result: "hit" | "miss";
  probedAt: string;
  url?: string;
  service?: FaviconService;
};

export type RegistryIcon = ResolvedIcon & { iconProbe?: IconProbeRecord };

export type RegistryIconsResult = {
  icons: Map<string, RegistryIcon>;
  /** Domains fetched this run, hits among them, fetches that threw. */
  faviconFetched: number;
  faviconHits: number;
  faviconFailed: number;
  /** Entries that needed a favicon while no public storage was configured. */
  faviconSkipped: number;
};

export const ICON_PROBE_MISS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAVICON_CONCURRENCY = 8;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The version's stored favicon outcome for `domain`, when it is well-formed
 * and still current at `now`: a hit with a stored URL is kept indefinitely
 * (the object is content-addressed and never changes), a miss for 30 days.
 */
export function storedIconProbe(
  value: unknown,
  domain: string,
  now: Date,
): IconProbeRecord | undefined {
  const stored = record(value);
  if (!stored || stored.domain !== domain) return undefined;
  const probedAt = new Date(
    typeof stored.probedAt === "string" ? stored.probedAt : Number.NaN,
  );
  if (Number.isNaN(probedAt.getTime())) return undefined;
  if (stored.result === "hit") {
    if (typeof stored.url !== "string") return undefined;
    try {
      if (new URL(stored.url).protocol !== "https:") return undefined;
    } catch {
      return undefined;
    }
    return {
      domain,
      result: "hit",
      probedAt: probedAt.toISOString(),
      url: stored.url,
      ...(stored.service === "google" || stored.service === "duckduckgo"
        ? { service: stored.service }
        : {}),
    };
  }
  if (stored.result === "miss") {
    const age = now.getTime() - probedAt.getTime();
    return age >= 0 && age < ICON_PROBE_MISS_MAX_AGE_MS
      ? { domain, result: "miss", probedAt: probedAt.toISOString() }
      : undefined;
  }
  return undefined;
}

/** `serverInfo.icons` out of a W1 `selfDescription` provenance, if any. */
function serverInfoIcons(selfDescription: unknown) {
  return record(record(selfDescription)?.serverInfo)?.icons;
}

/** `ownerAvatarUrl` out of a W5 `githubRegistry` provenance, if any. */
function githubRegistryAvatarUrl(githubRegistry: unknown) {
  return record(githubRegistry)?.ownerAvatarUrl;
}

export function iconChainInput(
  target: IconTarget,
  stored: StoredIconProvenance | undefined,
): IconChainInput {
  return {
    namespace: target.identifier.split("/")[0] ?? target.identifier,
    registryIconUrl: target.registryIconUrl,
    serverInfoIcons: serverInfoIcons(stored?.selfDescription),
    repositoryUrl: target.repositoryUrl,
    githubRegistryAvatarUrl: githubRegistryAvatarUrl(stored?.githubRegistry),
  };
}

export async function registryIcons(
  targets: IconTarget[],
  options: {
    now: Date;
    stored: Map<string, StoredIconProvenance>;
    fetchImpl?: typeof globalThis.fetch;
    store?: McpIconStore;
    /** Whether a favicon can be stored at all; the real config by default. */
    storeConfigured?: boolean;
    concurrency?: number;
  },
): Promise<RegistryIconsResult> {
  const { now } = options;
  const storeConfigured = options.storeConfigured ?? canStoreMcpIcons();
  const store = options.store ?? storeMcpIcon;
  const icons = new Map<string, RegistryIcon>();
  let faviconSkipped = 0;

  // Entries whose chain reached the favicon step, grouped by the domain to
  // fetch so each domain is fetched once per page.
  const pendingByDomain = new Map<
    string,
    Array<{ target: IconTarget; input: IconChainInput }>
  >();
  for (const target of targets) {
    const stored = options.stored.get(target.key);
    const input = iconChainInput(target, stored);
    const domain = namespaceDomain(input.namespace);
    const reusedProbe = domain
      ? storedIconProbe(stored?.iconProbe, domain, now)
      : undefined;
    const before = iconBeforeFavicon(input);
    if (before) {
      // Carry the cache so a registry icon that later disappears does not
      // cost a second fetch.
      icons.set(target.key, { ...before, iconProbe: reusedProbe });
      continue;
    }
    if (!domain) {
      icons.set(target.key, resolveIcon(input));
      continue;
    }
    if (reusedProbe) {
      icons.set(target.key, {
        ...resolveIcon(
          input,
          reusedProbe.result === "hit" ? reusedProbe.url : undefined,
        ),
        iconProbe: reusedProbe,
      });
      continue;
    }
    if (!storeConfigured) {
      faviconSkipped += 1;
      icons.set(target.key, resolveIcon(input));
      continue;
    }
    const group = pendingByDomain.get(domain) ?? [];
    group.push({ target, input });
    pendingByDomain.set(domain, group);
  }

  const domains = [...pendingByDomain.keys()];
  let faviconHits = 0;
  let faviconFailed = 0;
  let next = 0;
  const worker = async () => {
    while (next < domains.length) {
      const domain = domains[next++]!;
      const group = pendingByDomain.get(domain)!;
      let probe: IconProbeRecord | undefined;
      try {
        const fetched = await fetchFavicon(domain, options.fetchImpl);
        if (fetched.status === "hit") {
          const { url } = await store({
            domain,
            bytes: fetched.bytes,
            contentType: fetched.contentType,
          });
          probe = {
            domain,
            result: "hit",
            probedAt: now.toISOString(),
            url,
            service: fetched.service,
          };
          faviconHits += 1;
        } else {
          probe = { domain, result: "miss", probedAt: now.toISOString() };
        }
      } catch (error) {
        faviconFailed += 1;
        logger.warn("Registry federation favicon fetch failed", {
          domain,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const { target, input } of group) {
        icons.set(target.key, {
          ...resolveIcon(
            input,
            probe?.result === "hit" ? probe.url : undefined,
          ),
          iconProbe: probe,
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          options.concurrency ?? FAVICON_CONCURRENCY,
          domains.length,
        ),
      },
      worker,
    ),
  );

  if (faviconSkipped > 0) {
    logger.warn(
      "Registry federation: no public storage configured; favicons not fetched",
      { entries: faviconSkipped },
    );
  }
  return {
    icons,
    faviconFetched: domains.length,
    faviconHits,
    faviconFailed,
    faviconSkipped,
  };
}
