import { createHash } from "node:crypto";
import { logger } from "../../../shared/logger";
import { namespaceDomain } from "../claims/targets";
import {
  firstHttpsIconSrc,
  githubAvatarUrl,
  githubOwner,
  GITHUB_AVATAR_HOSTS,
  isGithubNamespace,
} from "./chain";
import { fetchCandidateImage, TransientIconError, type ImageOutcome } from "./candidate-image";
import { decideIcon, decisionDiffers } from "./decision";
import type {
  IconCandidate,
  IconCandidateSource,
  IconCandidatesRecord,
  IconDecision,
  IconTier,
} from "./dry-run-types";
import {
  createIconFetcher,
  type IconFetcher,
  type IconFetcherOptions,
  type IconRequestOptions,
} from "./icon-fetcher";
import {
  withIconScope,
  ICON_SUCCESS_REFRESH_MS,
  type IconStateStore,
} from "./icon-state";
import { sha256Hex } from "./image-validate";
import {
  scrapeSiteIcons,
  type SiteScrape,
  type SiteScrapeDeps,
} from "./site-icons";
import { httpsHostOf, registrableDomainOf, registrableDomainOfUrl } from "./site-domain";
import { evaluateSiteTrust, type SiteTrust } from "./site-trust";
import type { HashedIconStore } from "./store";

/**
 * The icon dry-run of a federation sync (Issue #367). Per entry it gathers the
 * candidate images from the sanctioned sources only —
 *
 * - the registry's `icons` and the endpoint's `serverInfo.icons`,
 * - the GitHub avatar (the owner of `io.github.<owner>` or of the declared
 *   repository, and the GitHub MCP Registry's `ownerAvatarUrl`),
 * - the stored namespace-domain favicon,
 * - the official site's icons, for a site of trust tier A or B (`site-trust.ts`)
 *
 * — fetches, validates and stores every one that decodes (`candidate-image.ts`),
 * and records `iconCandidates` and `iconDecision` on the version's provenance.
 * It never changes the displayed icon: the logo chain still decides that.
 * Failures here never fail the sync.
 */

export { decisionDiffers };

export type IconDryRunTarget = {
  /** The version id; the result is returned under it. */
  key: string;
  identifier: string;
  endpointUrl?: string;
  repositoryUrl?: string;
  registryIconUrl?: string;
  registryWebsiteUrl?: string;
  selfDescription?: unknown;
  authMetadata?: unknown;
  githubRegistry?: unknown;
  /** Our stored copy of the namespace domain's favicon, when one was fetched. */
  faviconUrl?: string;
  claimedDomains?: readonly string[];
  /** The registry that listed the entry verifies namespace ownership. */
  verified?: boolean;
  /** What the pages show today (the chain's answer). */
  current: IconDecision["current"];
};

export type StoredIconDryRun = {
  iconCandidates?: unknown;
  iconDecision?: unknown;
};

export type IconDryRunCounts = {
  entries: number;
  /** Candidates recomputed this run / reused from the stored record. */
  collected: number;
  reused: number;
  /** Left for a later sync: step off, page deadline, failure. */
  skipped: number;
  failed: number;
  sitesScraped: number;
  candidatesAccepted: number;
  picks: number;
  placeholders: number;
  /** Decisions that differ from the icon the pages show today. */
  differs: number;
};

export const emptyIconDryRunCounts = (): IconDryRunCounts => ({
  entries: 0,
  collected: 0,
  reused: 0,
  skipped: 0,
  failed: 0,
  sitesScraped: 0,
  candidatesAccepted: 0,
  picks: 0,
  placeholders: 0,
  differs: 0,
});

export function addIconDryRunCounts(
  total: IconDryRunCounts,
  add: IconDryRunCounts,
) {
  for (const key of Object.keys(total) as Array<keyof IconDryRunCounts>) {
    total[key] += add[key];
  }
}

export type IconDryRunEntryResult = {
  candidates: IconCandidatesRecord;
  decision: IconDecision;
};

export const SHARED_TEMPLATE_DOMAINS = 3;
export const ICON_DRY_RUN_CONCURRENCY = 12;
export const ICON_DRY_RUN_PAGE_DEADLINE_MS = 60_000;
const URL_JOB_TIMEOUT_MS = 20_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

type PlannedUrl = {
  source: IconCandidateSource;
  url: string;
  tier: IconTier;
  request: IconRequestOptions;
  servedBy?: string;
};

const GITHUB_ASSET_HOSTS = new Set(["raw.githubusercontent.com", "github.com"]);

/**
 * Whether an icon URL names the entry's own VERIFIED identity: a host under a
 * domain the platform has evidence for (a verified namespace, a verified
 * claim, a tier A site — never an endpoint's or a merely declared domain), or
 * a GitHub path under the owner of an authenticated `io.github.<owner>`
 * namespace (never an owner read from a repository URL).
 */
export function iconRelatesToIdentity(
  iconUrl: string,
  identity: { domains: readonly string[]; githubOwner?: string },
) {
  const domain = registrableDomainOfUrl(iconUrl);
  if (domain && identity.domains.includes(domain)) return true;
  try {
    const url = new URL(iconUrl);
    if (GITHUB_ASSET_HOSTS.has(url.hostname.toLowerCase()) && identity.githubOwner) {
      const owner = url.pathname.split("/").filter(Boolean)[0];
      return owner?.toLowerCase() === identity.githubOwner.toLowerCase();
    }
  } catch {
    // Not a URL: unrelated.
  }
  return false;
}

export function siteTrustOf(target: IconDryRunTarget): SiteTrust {
  const serverInfo = record(record(target.selfDescription)?.serverInfo);
  const authMetadata = record(target.authMetadata);
  return evaluateSiteTrust({
    namespace: target.identifier.split("/")[0] ?? target.identifier,
    namespaceVerified: target.verified === true,
    endpointUrl: target.endpointUrl,
    registryWebsiteUrl: target.registryWebsiteUrl,
    serverInfoWebsiteUrl: str(serverInfo?.websiteUrl),
    resourceDocumentationUrl: str(authMetadata?.resourceDocumentation),
    claimedDomains: target.claimedDomains,
  });
}

/** The URL candidates (everything except the official site) of one entry. */
export function planUrlCandidates(
  target: IconDryRunTarget,
  trust: SiteTrust,
  ownStorageHost: string | undefined,
): PlannedUrl[] {
  const namespace = target.identifier.split("/")[0] ?? target.identifier;
  const verified = target.verified === true;
  const nsDomain = verified ? namespaceDomain(namespace) : null;
  const nsRegistrable = nsDomain ? registrableDomainOf(nsDomain) : undefined;
  const namespaceOwner =
    verified && isGithubNamespace(namespace)
      ? githubOwner({ namespace })
      : undefined;
  const identity = {
    domains: [
      nsRegistrable,
      ...(target.claimedDomains ?? []).map((d) => registrableDomainOf(d)),
      // Only a site we hold proof for; a tier B site is a declaration.
      trust.tier === "A" ? trust.domain : undefined,
    ].filter((d): d is string => Boolean(d)),
    githubOwner: namespaceOwner,
  };
  const planned: PlannedUrl[] = [];
  const open = (url: string): IconRequestOptions | undefined => {
    const host = httpsHostOf(url);
    return host ? { approvedHosts: new Set([host]) } : undefined;
  };
  /** The registrable domain that serves a declared icon, for the template count. */
  const servedBy = (url: string) =>
    GITHUB_ASSET_HOSTS.has(httpsHostOf(url) ?? "") ||
    GITHUB_AVATAR_HOSTS.includes(httpsHostOf(url) ?? "")
      ? undefined
      : registrableDomainOfUrl(url);

  if (target.registryIconUrl) {
    const request = open(target.registryIconUrl);
    if (request) {
      // The registry does not authenticate the icon's host: an icon is the
      // publisher's own only when it sits on a domain or GitHub account the
      // platform has evidence for; anywhere else it is a bare declaration.
      const tier = iconRelatesToIdentity(target.registryIconUrl, identity) ? "A" : "C";
      planned.push({
        source: "registry",
        url: target.registryIconUrl,
        tier,
        request,
        servedBy: tier === "C" ? undefined : servedBy(target.registryIconUrl),
      });
    }
  }
  const serverInfoIcon = firstHttpsIconSrc(
    record(record(target.selfDescription)?.serverInfo)?.icons,
  );
  if (serverInfoIcon) {
    const request = open(serverInfoIcon);
    if (request) {
      const tier = iconRelatesToIdentity(serverInfoIcon, identity) ? "B" : "C";
      planned.push({
        source: "server-info",
        url: serverInfoIcon,
        tier,
        request,
        servedBy: tier === "C" ? undefined : servedBy(serverInfoIcon),
      });
    }
  }
  const githubRequest: IconRequestOptions = {
    approvedHosts: new Set(GITHUB_AVATAR_HOSTS),
    redirectHosts: new Set(GITHUB_AVATAR_HOSTS),
    skipRobots: true,
  };
  const owner = githubOwner({ namespace, repositoryUrl: target.repositoryUrl });
  if (owner) {
    planned.push({
      source: "github-avatar",
      url: githubAvatarUrl(owner),
      // An authenticated `io.github.<owner>` namespace is proof of that GitHub
      // account; an owner only read from a repository URL proves nothing.
      tier: namespaceOwner ? "A" : "C",
      request: githubRequest,
    });
  }
  const registryAvatar = str(record(target.githubRegistry)?.ownerAvatarUrl);
  const registryAvatarHost = registryAvatar ? httpsHostOf(registryAvatar) : undefined;
  if (registryAvatar && registryAvatarHost && GITHUB_AVATAR_HOSTS.includes(registryAvatarHost)) {
    planned.push({
      source: "github-registry",
      url: registryAvatar,
      tier: "B",
      request: githubRequest,
    });
  }
  if (target.faviconUrl && nsRegistrable) {
    const host = httpsHostOf(target.faviconUrl);
    if (host && host === ownStorageHost) {
      const tier = trust.tier === "A" && trust.domain === nsRegistrable ? "A" : "C";
      planned.push({
        source: "favicon",
        url: target.faviconUrl,
        // The namespace domain is the publisher's; its favicon stands for the
        // entry only when the endpoint is confirmed under that domain.
        tier,
        request: { approvedHosts: new Set([host]), skipRobots: true },
        servedBy: tier === "C" ? undefined : nsRegistrable,
      });
    }
  }
  return planned;
}

export type IconDryRunDeps = {
  state: IconStateStore;
  store: HashedIconStore;
  /** The host our own bucket is served from; a favicon copy must be there. */
  ownStorageHost?: string;
  now: Date;
  owner?: string;
  fetcherOptions?: Omit<IconFetcherOptions, "signal">;
  createFetcher?: (options: IconFetcherOptions) => IconFetcher;
  jobTimeoutMs?: number;
  /** `Date.now()` after which no further fetch is started (the page deadline). */
  deadlineAt?: number;
};

function siteScope(host: string) {
  return `site:${host.replace(/^www\./, "")}`;
}
/** Every host of one registrable domain takes turns on this lock. */
const siteLock = (host: string) => `lock:${registrableDomainOf(host) ?? host}`;
const urlScope = (url: string) => `url:${sha256Hex(Buffer.from(url))}`;

export type IconDryRunSession = ReturnType<typeof createIconDryRunSession>;

/**
 * A session shares per-run memoization (one scrape per site across the page's
 * entries) and the lease owner id; the durable sharing is the state store's.
 */
export function createIconDryRunSession(deps: IconDryRunDeps) {
  const owner = deps.owner ?? `dry-run:${process.pid}:${createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 8)}`;
  const sites = new Map<
    string,
    Promise<{ scrape?: SiteScrape; complete: boolean; fetched: boolean }>
  >();
  const makeFetcher = deps.createFetcher ?? createIconFetcher;

  async function siteScrape(host: string) {
    const scope = siteScope(host);
    let pending = sites.get(scope);
    if (!pending) {
      pending = (async () => {
        const siteDeps: SiteScrapeDeps = {
          state: deps.state,
          store: deps.store,
          createFetcher: deps.createFetcher,
          jobTimeoutMs: deps.jobTimeoutMs,
          fetcherOptions: deps.fetcherOptions,
        };
        const outcome = await withIconScope<SiteScrape>(
          deps.state,
          scope,
          { owner, now: deps.now, lockScope: siteLock(host) },
          () => scrapeSiteIcons(host, siteDeps),
        );
        if (outcome.kind === "busy") return { complete: false, fetched: false };
        return {
          scrape: outcome.result,
          complete: outcome.status === "ok" || outcome.status === "denied",
          fetched: outcome.kind === "fetched",
        };
      })();
      sites.set(scope, pending);
      pending.catch(() => sites.delete(scope));
    }
    return pending;
  }

  type UrlScopeResult = ImageOutcome & { error?: string };
  type UrlCandidate = { rejection?: string; complete: boolean } & ImageOutcome;
  // One fetch per image per run, however many of the page's entries declare it
  // (an owner's avatar); across workers the state store's lease does the same.
  const urls = new Map<string, Promise<UrlCandidate>>();

  function urlCandidate(planned: PlannedUrl): Promise<UrlCandidate> {
    const scope = urlScope(planned.url);
    let pending = urls.get(scope);
    if (!pending) {
      pending = fetchUrlCandidate(planned, scope);
      urls.set(scope, pending);
      // A thrown failure is not shared: the next entry asking tries again.
      pending.catch(() => urls.delete(scope));
    }
    return pending;
  }

  async function fetchUrlCandidate(
    planned: PlannedUrl,
    scope: string,
  ): Promise<UrlCandidate> {
    const outcome = await withIconScope<UrlScopeResult>(
      deps.state,
      scope,
      { owner, now: deps.now },
      async () => {
        const fetcher = makeFetcher({
          ...deps.fetcherOptions,
          signal: AbortSignal.timeout(URL_JOB_TIMEOUT_MS),
        });
        try {
          const result = await fetchCandidateImage(
            fetcher,
            planned.url,
            planned.request,
            deps,
            planned.servedBy,
          );
          return { status: "ok", result };
        } catch (error) {
          if (error instanceof TransientIconError) {
            return {
              status: error.deferred ? "deferred" : "error",
              result: { error: error.code },
            };
          }
          throw error;
        } finally {
          await fetcher.close();
        }
      },
    );
    if (outcome.kind === "busy") return { rejection: "fetch-busy", complete: false };
    if (!outcome.result) return { rejection: "fetch-unavailable", complete: false };
    const { error, ...image } = outcome.result;
    if (error) return { rejection: `fetch-error:${error}`, complete: false };
    return { ...image, complete: true };
  }

  /** Candidates and decision of one entry, reusing a current stored record. */
  async function collectEntry(
    target: IconDryRunTarget,
    stored: StoredIconDryRun | undefined,
  ): Promise<{
    result: IconDryRunEntryResult;
    reused: boolean;
    scraped: number;
  }> {
    const trust = siteTrustOf(target);
    const planned = planUrlCandidates(target, trust, deps.ownStorageHost);
    const siteHost =
      trust.tier === "A" || trust.tier === "B" ? trust.host : undefined;
    const inputKey = createHash("sha256")
      .update(
        JSON.stringify([
          planned.map((p) => [p.source, p.url, p.tier]).sort(),
          siteHost ? [siteHost, trust.tier] : null,
          target.verified === true,
        ]),
      )
      .digest("hex")
      .slice(0, 32);

    const previous = record(stored?.iconCandidates);
    const previousItems = previous?.items;
    const previousAt = new Date(str(previous?.checkedAt) ?? Number.NaN);
    if (
      previous?.version === 1 &&
      previous.inputKey === inputKey &&
      previous.complete === true &&
      Array.isArray(previousItems) &&
      !Number.isNaN(previousAt.getTime()) &&
      deps.now.getTime() - previousAt.getTime() < ICON_SUCCESS_REFRESH_MS &&
      previousAt.getTime() <= deps.now.getTime()
    ) {
      const candidates = previous as unknown as IconCandidatesRecord;
      return {
        result: {
          candidates,
          decision: decideIcon({
            site: trust,
            candidates: candidates.items,
            current: target.current,
            now: deps.now,
          }),
        },
        reused: true,
        scraped: 0,
      };
    }

    const items: IconCandidate[] = [];
    let complete = true;
    let scraped = 0;
    const pastDeadline = () =>
      deps.deadlineAt !== undefined && Date.now() > deps.deadlineAt;
    for (const plan of planned) {
      if (plan.tier === "C") {
        // A bare declaration is recorded, never fetched or stored.
        items.push({
          source: plan.source,
          url: plan.url,
          tier: "C",
          rejection: "tier-c-not-fetched",
        });
        continue;
      }
      if (pastDeadline()) {
        complete = false;
        continue;
      }
      const image = await urlCandidate(plan);
      if (!image.complete) complete = false;
      const { complete: _complete, ...fields } = image;
      items.push({ source: plan.source, url: plan.url, tier: plan.tier, ...fields });
    }
    if (siteHost && pastDeadline()) {
      complete = false;
    } else if (siteHost && (trust.tier === "A" || trust.tier === "B")) {
      const site = await siteScrape(siteHost);
      if (!site.complete) complete = false;
      if (site.fetched) scraped += 1;
      const root = `https://${siteHost}/`;
      if (!site.scrape) {
        items.push({
          source: "site",
          url: root,
          tier: trust.tier,
          rejection: "site-unavailable",
        });
      } else if (site.scrape.outcome === "icons" || site.scrape.outcome === "no-icons") {
        if (site.scrape.candidates.length === 0) {
          items.push({ source: "site", url: root, tier: trust.tier, rejection: "site-no-icons" });
        }
        for (const candidate of site.scrape.candidates) {
          items.push({ source: "site", tier: trust.tier, ...candidate });
        }
      } else {
        items.push({
          source: "site",
          url: root,
          tier: trust.tier,
          rejection: site.scrape.reason
            ? `site-${site.scrape.outcome}:${site.scrape.reason}`
            : `site-${site.scrape.outcome}`,
        });
      }
    }
    // The same image served from several unrelated registrable domains is a
    // template signal for the reviewer, not proof either way. Only domains we
    // hold evidence for are ever counted (tier A/B candidates record them).
    for (const item of items) {
      if (item.rejection || !item.sha256) continue;
      const domains = await deps.state.countHashDomains(item.sha256);
      if (domains >= SHARED_TEMPLATE_DOMAINS) {
        item.signals = [...(item.signals ?? []), `shared-template:${domains}`];
      }
    }
    const candidates: IconCandidatesRecord = {
      version: 1,
      checkedAt: deps.now.toISOString(),
      inputKey,
      complete,
      items,
    };
    return {
      result: {
        candidates,
        decision: decideIcon({
          site: trust,
          candidates: items,
          current: target.current,
          now: deps.now,
        }),
      },
      reused: false,
      scraped,
    };
  }

  return { collectEntry };
}

/**
 * The dry-run of one registry page: every target through a small worker pool,
 * stopping to start new entries at the page deadline. An entry that cannot be
 * done is simply absent from `results` (the sync keeps whatever the version
 * stored before).
 */
export async function runIconDryRun(
  targets: IconDryRunTarget[],
  stored: Map<string, StoredIconDryRun>,
  deps: IconDryRunDeps & { concurrency?: number; deadlineMs?: number },
): Promise<{
  results: Map<string, IconDryRunEntryResult>;
  counts: IconDryRunCounts;
}> {
  const deadline = Date.now() + (deps.deadlineMs ?? ICON_DRY_RUN_PAGE_DEADLINE_MS);
  const session = createIconDryRunSession({ ...deps, deadlineAt: deadline });
  const counts = emptyIconDryRunCounts();
  const results = new Map<string, IconDryRunEntryResult>();
  counts.entries = targets.length;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      if (Date.now() > deadline) {
        counts.skipped += 1;
        continue;
      }
      try {
        const previous = record(stored.get(target.key)?.iconCandidates);
        const done = await session.collectEntry(target, stored.get(target.key));
        if (!done.result.candidates.complete && previous?.complete === true) {
          // A fetch that was busy, deferred or out of time must not replace a
          // complete record the version already has: keep the old one.
          counts.skipped += 1;
          continue;
        }
        results.set(target.key, done.result);
        if (done.reused) counts.reused += 1;
        else counts.collected += 1;
        counts.sitesScraped += done.scraped;
        counts.candidatesAccepted += done.result.candidates.items.filter(
          (item) => !item.rejection && item.sha256,
        ).length;
        if (done.result.decision.outcome === "pick") counts.picks += 1;
        else counts.placeholders += 1;
        if (decisionDiffers(done.result.decision)) counts.differs += 1;
      } catch (error) {
        counts.failed += 1;
        logger.warn("Registry federation icon dry-run failed", {
          identifier: target.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(deps.concurrency ?? ICON_DRY_RUN_CONCURRENCY, targets.length),
      },
      worker,
    ),
  );
  return { results, counts };
}
