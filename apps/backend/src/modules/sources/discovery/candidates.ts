import type { SourceDiscoveryCandidate } from "@sourceweft/contracts/sources";
import { validatePublicHttpUrl } from "@sourceweft/builtin-document-parsers";

/** Results asked of each search query, and the most candidates one discovery returns. */
export const DISCOVERY_RESULTS_PER_QUERY = 5;
export const DISCOVERY_MAX_CANDIDATES = 20;
export const DISCOVERY_MAX_QUERIES = 5;

const YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com", "youtu.be"];
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
]);

export type RawSearchHit = {
  title?: string;
  url: string;
  snippet?: string;
};

/**
 * A page's identity for de-duplication: no fragment, no tracking parameters,
 * no trailing slash, lower-case host. Null when it is not a public http(s) URL
 * (the same check a hand-added URL passes).
 */
export function normalizeCandidateUrl(value: string) {
  let url: URL;
  try {
    url = new URL(validatePublicHttpUrl(value.trim()));
  } catch {
    return null;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      TRACKING_PARAMS.has(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function isYouTube(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return YOUTUBE_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function cleanText(value: string | undefined, max: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/**
 * Turns raw search hits into candidates: public pages only, YouTube left out
 * (it cannot be added as a web source), one entry per page, in the order the
 * searches returned them, capped.
 */
export function buildCandidates(input: {
  hits: readonly RawSearchHit[];
  limit?: number;
}): Array<Omit<SourceDiscoveryCandidate, "existingSourceId">> {
  const limit = input.limit ?? DISCOVERY_MAX_CANDIDATES;
  const seen = new Set<string>();
  const candidates: Array<Omit<SourceDiscoveryCandidate, "existingSourceId">> =
    [];
  for (const hit of input.hits) {
    const url = normalizeCandidateUrl(hit.url);
    if (!url || seen.has(url)) continue;
    const { hostname } = new URL(url);
    if (isYouTube(hostname)) continue;
    seen.add(url);
    candidates.push({
      url,
      title: cleanText(hit.title, 200) || hostname.replace(/^www\./, ""),
      snippet: cleanText(hit.snippet, 300),
      domain: hostname.replace(/^www\./, ""),
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/** Interleaves result lists so every query contributes before any contributes twice. */
export function interleaveHits(lists: ReadonlyArray<readonly RawSearchHit[]>) {
  const merged: RawSearchHit[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const hit = list[index];
      if (hit) merged.push(hit);
    }
  }
  return merged;
}
