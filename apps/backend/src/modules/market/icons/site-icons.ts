import {
  classifyPage,
  extractHead,
  extractManifestIcons,
  type DeclaredIcon,
} from "./head-extract";
import {
  createIconFetcher,
  IconFetchError,
  type IconFetcher,
  type IconFetcherOptions,
} from "./icon-fetcher";
import type { IconStateStore, ScopeOutcome } from "./icon-state";
import { fetchCandidateImage, TransientIconError } from "./candidate-image";
import { registrableDomainOf, registrableDomainOfUrl, wwwTwin } from "./site-domain";
import type { HashedIconStore } from "./store";
import type { IconCandidate, SiteIconKind } from "./dry-run-types";

/**
 * One official site's icons (Issue #367 dry-run), for a site an entry's trust
 * tier allows (A or B; never C). The page is read once: robots.txt of the
 * host, then `/`, whose `<head>` yields the icon links, the manifest link and
 * a title for parked/challenge detection; then the manifest, then at most
 * eight candidate images. Nothing else of the page is read, `<base>` is
 * ignored, `og:image` is never used, descriptions are never extracted.
 *
 * Icons and the manifest must live on the site's own registrable domain: a
 * page cannot send the fetch to another company's host by declaring it. Raw
 * SVG and mask icons are recorded as rejected, not fetched.
 */

export const MAX_SITE_CANDIDATES = 8;
export const SITE_JOB_TIMEOUT_MS = 30_000;

export type SiteScrapeOutcome =
  | "icons"
  | "no-icons"
  | "parked"
  | "challenge"
  | "robots-disallowed"
  | "page-unavailable";

export type SiteCandidate = Pick<
  IconCandidate,
  "url" | "sha256" | "width" | "height" | "storedUrl" | "rejection"
> & { kind: SiteIconKind };

export type SiteScrape = {
  host: string;
  outcome: SiteScrapeOutcome;
  /** Why the page could not be read, for `page-unavailable`. */
  reason?: string;
  candidates: SiteCandidate[];
};

type Planned = { kind: SiteIconKind; url: string; size?: number; reject?: string };

const isSvg = (icon: DeclaredIcon) =>
  icon.type === "image/svg+xml" || /\.svg(?:$|\?)/i.test(new URL(icon.url).pathname + new URL(icon.url).search);

/**
 * The candidates to try, best first, at most `MAX_SITE_CANDIDATES`: raster
 * apple-touch-icons, manifest icons and `rel=icon` links (larger first), the
 * implicit `/favicon.ico` when no `rel=icon` is declared, then the SVG and
 * mask-icon declarations, which are only recorded as rejected.
 */
export function planSiteCandidates(
  icons: DeclaredIcon[],
  origin: string,
): Planned[] {
  const byKind: Record<string, DeclaredIcon[]> = {
    "apple-touch-icon": [],
    "manifest-icon": [],
    icon: [],
  };
  const rejected: Planned[] = [];
  for (const icon of icons) {
    if (icon.rel === "mask-icon") {
      rejected.push({ kind: "mask-icon", url: icon.url, reject: "mask-icon-not-published" });
    } else if (isSvg(icon)) {
      rejected.push({
        kind: icon.rel === "manifest-icon" ? "manifest-icon" : (icon.rel as SiteIconKind),
        url: icon.url,
        reject: "svg-not-published",
      });
    } else {
      byKind[icon.rel]!.push(icon);
    }
  }
  const bySize = (a: DeclaredIcon, b: DeclaredIcon) => (b.size ?? 0) - (a.size ?? 0);
  const raster: Planned[] = [];
  for (const kind of ["apple-touch-icon", "manifest-icon", "icon"] as const) {
    for (const icon of byKind[kind]!.sort(bySize)) {
      raster.push({ kind, url: icon.url, size: icon.size });
    }
  }
  const hasIconLink = icons.some((icon) => icon.rel === "icon");
  if (!hasIconLink) {
    raster.push({ kind: "implicit-favicon", url: `${origin}/favicon.ico` });
  }
  const seen = new Set<string>();
  const out: Planned[] = [];
  for (const planned of [...raster, ...rejected]) {
    if (seen.has(planned.url)) continue;
    seen.add(planned.url);
    out.push(planned);
    if (out.length >= MAX_SITE_CANDIDATES) break;
  }
  return out;
}

export type SiteScrapeDeps = {
  state: IconStateStore;
  store: HashedIconStore;
  /** A fetcher whose requests end with `signal`; the real one by default. */
  createFetcher?: (options: IconFetcherOptions) => IconFetcher;
  jobTimeoutMs?: number;
  fetcherOptions?: Omit<IconFetcherOptions, "signal">;
};

export async function scrapeSiteIcons(
  host: string,
  deps: SiteScrapeDeps,
): Promise<ScopeOutcome<SiteScrape>> {
  const siteDomain = registrableDomainOf(host);
  if (!siteDomain) return { status: "denied" };
  const fetcher = (deps.createFetcher ?? createIconFetcher)({
    ...deps.fetcherOptions,
    signal: AbortSignal.timeout(deps.jobTimeoutMs ?? SITE_JOB_TIMEOUT_MS),
  });
  const approvedHosts = new Set([host, wwwTwin(host)]);
  const result: SiteScrape = { host, outcome: "page-unavailable", candidates: [] };
  try {
    const page = await fetcher.checkedFetch(`https://${host}/`, "html", {
      approvedHosts,
    });
    const head = extractHead(page.body.toString("utf8"), page.url);
    const signal = classifyPage({
      status: page.status,
      title: head.title,
      headers: page.headers,
    });
    if (signal) {
      result.outcome = signal;
      return { status: "denied", result };
    }
    if (page.status < 200 || page.status >= 300) {
      result.reason = `http-${page.status}`;
      return page.status === 429 || page.status >= 500
        ? { status: "deferred", result }
        : { status: "error", result };
    }
    const pageOrigin = new URL(page.url).origin;
    const declared: DeclaredIcon[] = [...head.icons];
    if (head.manifestUrl && registrableDomainOfUrl(head.manifestUrl) === siteDomain) {
      try {
        const manifest = await fetcher.checkedFetch(head.manifestUrl, "manifest", {
          approvedHosts: new Set([new URL(head.manifestUrl).hostname.toLowerCase()]),
        });
        if (manifest.status >= 200 && manifest.status < 300) {
          declared.push(
            ...extractManifestIcons(manifest.body.toString("utf8"), manifest.url),
          );
        }
      } catch (error) {
        // A missing or refused manifest only costs its icons; a transient
        // failure of the host defers the whole site below via the images.
        if (
          error instanceof IconFetchError &&
          (error.code === "private-address" || error.code === "robots-unavailable")
        ) {
          throw error;
        }
      }
    }
    let transient: TransientIconError | undefined;
    for (const planned of planSiteCandidates(declared, pageOrigin)) {
      if (planned.reject) {
        result.candidates.push({
          kind: planned.kind,
          url: planned.url,
          rejection: planned.reject,
        });
        continue;
      }
      if (registrableDomainOfUrl(planned.url) !== siteDomain) {
        result.candidates.push({
          kind: planned.kind,
          url: planned.url,
          rejection: "host-not-approved",
        });
        continue;
      }
      try {
        const image = await fetchCandidateImage(
          fetcher,
          planned.url,
          { approvedHosts: new Set([new URL(planned.url).hostname.toLowerCase()]) },
          deps,
          siteDomain,
        );
        result.candidates.push({ kind: planned.kind, url: planned.url, ...image });
      } catch (error) {
        if (error instanceof TransientIconError) {
          transient = error;
          result.candidates.push({
            kind: planned.kind,
            url: planned.url,
            rejection: error.code,
          });
          continue;
        }
        throw error;
      }
    }
    result.outcome = result.candidates.some((c) => c.storedUrl)
      ? "icons"
      : "no-icons";
    // A site whose every fetch failed transiently is retried, not cached as
    // having no icons.
    if (transient && !result.candidates.some((c) => !c.rejection)) {
      return { status: transient.deferred ? "deferred" : "error", result };
    }
    return { status: "ok", result };
  } catch (error) {
    if (error instanceof IconFetchError) {
      result.reason ??= error.code;
      if (error.code === "robots-disallowed") {
        result.outcome = "robots-disallowed";
        return { status: "denied", result };
      }
      if (error.code === "private-address" || error.code === "scheme") {
        return { status: "denied", result };
      }
      return {
        status: error.code === "robots-unavailable" ? "deferred" : "error",
        result,
      };
    }
    throw error;
  } finally {
    await fetcher.close();
  }
}
