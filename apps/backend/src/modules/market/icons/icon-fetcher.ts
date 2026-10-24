import { Agent } from "undici";
import {
  checkEndpointUrl,
  EndpointPolicyError,
  resolveEndpointAddresses,
  type EndpointLookup,
  type EndpointPolicy,
} from "../../../shared/security/endpoint-policy";
import { robotsAllows } from "./robots";
import { wwwTwin } from "./site-domain";

/**
 * The bounded, credential-free HTTP client of the icon dry-run (Issue #367).
 * The platform's controlled fetch is for credentialed traffic: it rejects
 * every cross-origin redirect and has no deadline or body cap. Icon requests
 * carry no credentials at all, so they may follow a short, explicitly scoped
 * chain of redirects, and they must be bounded:
 *
 * - https only, on port 443, never with embedded credentials; no cookies,
 *   authorization or other state is ever sent (each hop builds its headers
 *   from scratch) and none is kept;
 * - the address is validated at socket time on every connection (the same
 *   resolver the controlled fetch uses: public addresses only);
 * - at most three redirects. Before each hop the destination is checked: the
 *   same origin, the same host's `www.` twin, or a host the caller named
 *   (GitHub's two avatar hosts). An equal registrable domain alone is not
 *   enough;
 * - one deadline per resource covering the redirects and the body read, plus
 *   the caller's job signal; bodies are capped while streaming (decoded). A
 *   page is read as far as its cap and parsed from there (its `<head>` comes
 *   first); every other resource over its cap is refused;
 * - robots.txt of the fetched origin is honoured (`checkedFetch`).
 */

export const ICON_USER_AGENT = "SourceWeftIconFetcher/1";
export const ICON_FETCH_LIMITS = {
  html: 256 * 1024,
  manifest: 64 * 1024,
  robots: 64 * 1024,
  image: 1024 * 1024,
} as const;
export type IconFetchKind = keyof typeof ICON_FETCH_LIMITS;
export const ICON_RESOURCE_TIMEOUT_MS = 5000;
export const ICON_MAX_REDIRECTS = 3;

export type IconFetchErrorCode =
  | "scheme"
  | "host-not-approved"
  | "private-address"
  | "redirect-limit"
  | "redirect-not-approved"
  | "too-large"
  | "timeout"
  | "network"
  /** robots.txt forbids the path. */
  | "robots-disallowed"
  /** robots.txt could not be read (429, 5xx, network): try again later. */
  | "robots-unavailable";

export class IconFetchError extends Error {
  constructor(
    readonly code: IconFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IconFetchError";
  }
}

export type IconFetchResponse = {
  status: number;
  /** Lowercased names; only the headers the dry-run reads are kept. */
  headers: Record<string, string>;
  body: Buffer;
  /** The address the body came from, after redirects. */
  url: string;
};

/** The one network call; a test replaces it. */
export type IconTransport = (
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

const KEPT_HEADERS = [
  "content-type",
  "content-length",
  "location",
  "server",
  "cf-mitigated",
] as const;

const PUBLIC_POLICY: EndpointPolicy = {
  enforceAddressChecks: true,
  allowedInternalOrigins: [],
};

export type IconFetcherOptions = {
  transport?: IconTransport;
  lookup?: EndpointLookup;
  resourceTimeoutMs?: number;
  /** Aborts every request of this fetcher (the job's overall deadline). */
  signal?: AbortSignal;
};

export type IconRequestOptions = {
  /** Hosts a request may start on (and follow a redirect to, besides its twin). */
  approvedHosts: ReadonlySet<string>;
  /** Further hosts a redirect may reach. */
  redirectHosts?: ReadonlySet<string>;
  /** Skip robots.txt: only for fixed, operator-chosen hosts. */
  skipRobots?: boolean;
};

function abortError(signal: AbortSignal) {
  return signal.reason instanceof IconFetchError
    ? signal.reason
    : new IconFetchError("timeout", "Icon fetch timed out");
}

/**
 * Reads `response` up to `limit` bytes, giving up when `signal` aborts. Past
 * the limit it fails (`too-large`), or with `truncate` keeps the first `limit`
 * bytes and stops: a page's `<head>` is at its start, so a large page is read
 * as far as the cap and not refused.
 */
async function readCapped(
  response: Response,
  limit: number,
  signal: AbortSignal,
  truncate: boolean,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new IconFetchError("too-large", "Icon response body is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(abortError(signal));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        if (!truncate) {
          throw new IconFetchError("too-large", "Icon response body is too large");
        }
        chunks.push(value.subarray(0, value.byteLength - (size - limit)));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

export function createIconFetcher(options: IconFetcherOptions = {}) {
  const timeoutMs = options.resourceTimeoutMs ?? ICON_RESOURCE_TIMEOUT_MS;
  const agents = new Map<string, Agent>();
  let denial: IconFetchError | undefined;
  const robotsByOrigin = new Map<
    string,
    Promise<{ text: string } | "none" | "defer">
  >();

  function agentFor(url: URL) {
    let agent = agents.get(url.origin);
    if (agent) return agent;
    agent = new Agent({
      connect: {
        lookup: (_hostname, lookupOptions, callback) => {
          // Validated inside socket creation: no second lookup follows, so
          // a rebinding answer cannot reach a private address.
          resolveEndpointAddresses(url, PUBLIC_POLICY, options.lookup).then(
            (addresses) => {
              if (lookupOptions.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            },
            (error: unknown) => {
              if (error instanceof EndpointPolicyError) {
                denial ??= new IconFetchError(
                  "private-address",
                  "Icon host resolves to a non-public address",
                );
              }
              callback(
                error instanceof Error ? error : new Error("lookup failed"),
                "",
                0,
              );
            },
          );
        },
      },
    });
    agents.set(url.origin, agent);
    return agent;
  }

  const transport: IconTransport =
    options.transport ??
    ((url, init) =>
      globalThis.fetch(url, {
        method: "GET",
        headers: init.headers,
        redirect: "manual",
        credentials: "omit",
        signal: init.signal,
        dispatcher: agentFor(url),
      } as RequestInit & { dispatcher: Agent }));

  function assertStartUrl(url: URL, approved: ReadonlySet<string>) {
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new IconFetchError("scheme", "Icon URL must be plain https");
    }
    if (url.port && url.port !== "443") {
      throw new IconFetchError("scheme", "Icon URL must use the https port");
    }
    try {
      checkEndpointUrl(url.toString(), PUBLIC_POLICY);
    } catch {
      throw new IconFetchError(
        "private-address",
        "Icon host is not a public host",
      );
    }
    if (!approved.has(url.hostname.toLowerCase())) {
      throw new IconFetchError(
        "host-not-approved",
        `Icon host ${url.hostname} is not approved for this site`,
      );
    }
  }

  function redirectAllowed(from: URL, to: URL, extra: ReadonlySet<string>) {
    if (to.protocol !== "https:" || to.username || to.password) return false;
    if (to.port && to.port !== "443") return false;
    const host = to.hostname.toLowerCase();
    const origin = from.hostname.toLowerCase();
    return host === origin || host === wwwTwin(origin) || extra.has(host);
  }

  /** One resource: the redirects and the body under a single deadline. */
  async function fetchBounded(
    start: string,
    kind: IconFetchKind,
    request: IconRequestOptions,
  ): Promise<IconFetchResponse> {
    let current: URL;
    try {
      current = new URL(start);
    } catch {
      throw new IconFetchError("scheme", "Icon URL is not valid");
    }
    assertStartUrl(current, request.approvedHosts);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline;
    for (let hop = 0; ; hop += 1) {
      // Headers are built per hop from nothing: no cookie, authorization or
      // referrer can ride along.
      const headers = { "user-agent": ICON_USER_AGENT, accept: "*/*" };
      let response: Response;
      try {
        response = await transport(current, { headers, signal });
      } catch (error) {
        if (denial) {
          const denied = denial;
          denial = undefined;
          throw denied;
        }
        if (signal.aborted) throw abortError(signal);
        if (error instanceof IconFetchError) throw error;
        throw new IconFetchError("network", "Icon fetch failed");
      }
      const keptHeaders: Record<string, string> = {};
      for (const name of KEPT_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) keptHeaders[name] = value;
      }
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        keptHeaders.location
      ) {
        await response.body?.cancel().catch(() => {});
        if (hop >= ICON_MAX_REDIRECTS) {
          throw new IconFetchError("redirect-limit", "Too many icon redirects");
        }
        let next: URL;
        try {
          next = new URL(keptHeaders.location, current);
        } catch {
          throw new IconFetchError("redirect-not-approved", "Bad redirect");
        }
        if (!redirectAllowed(current, next, request.redirectHosts ?? new Set())) {
          throw new IconFetchError(
            "redirect-not-approved",
            `Icon redirect to ${next.hostname} is not approved`,
          );
        }
        try {
          checkEndpointUrl(next.toString(), PUBLIC_POLICY);
        } catch {
          throw new IconFetchError(
            "private-address",
            "Icon redirect target is not a public host",
          );
        }
        current = next;
        continue;
      }
      const body = await readCapped(
        response,
        ICON_FETCH_LIMITS[kind],
        signal,
        kind === "html",
      );
      return {
        status: response.status,
        headers: keptHeaders,
        body,
        url: current.toString(),
      };
    }
  }

  async function robotsFor(url: URL) {
    const existing = robotsByOrigin.get(url.origin);
    if (existing) return existing;
    const pending = (async () => {
      const host = url.hostname.toLowerCase();
      let response: IconFetchResponse;
      try {
        response = await fetchBounded(`${url.origin}/robots.txt`, "robots", {
          approvedHosts: new Set([host]),
        });
      } catch (error) {
        if (
          error instanceof IconFetchError &&
          (error.code === "private-address" || error.code === "scheme")
        ) {
          throw error;
        }
        return "defer" as const;
      }
      if (response.status === 404 || response.status === 410) {
        return "none" as const;
      }
      if (response.status >= 200 && response.status < 300) {
        return { text: response.body.toString("utf8") };
      }
      // 429, 5xx and the other 4xx (a 403 is often a bot wall): decide later.
      return "defer" as const;
    })();
    robotsByOrigin.set(url.origin, pending);
    return pending;
  }

  return {
    /** One bounded resource, without consulting robots.txt. */
    fetch: fetchBounded,
    /**
     * One bounded resource after its origin's robots.txt allows the path:
     * a 404 there allows everything, a disallow stops (`robots-disallowed`),
     * a failure to read it defers (`robots-unavailable`).
     */
    async checkedFetch(
      start: string,
      kind: IconFetchKind,
      request: IconRequestOptions,
    ): Promise<IconFetchResponse> {
      if (!request.skipRobots) {
        let url: URL;
        try {
          url = new URL(start);
        } catch {
          throw new IconFetchError("scheme", "Icon URL is not valid");
        }
        assertStartUrl(url, request.approvedHosts);
        const robots = await robotsFor(url);
        if (robots === "defer") {
          throw new IconFetchError(
            "robots-unavailable",
            "robots.txt could not be read",
          );
        }
        if (robots !== "none" && !robotsAllows(robots.text, url.pathname + url.search)) {
          throw new IconFetchError(
            "robots-disallowed",
            "robots.txt disallows the path",
          );
        }
      }
      return fetchBounded(start, kind, request);
    },
    async close() {
      const pending = [...agents.values()].map((agent) => agent.destroy());
      agents.clear();
      await Promise.all(pending);
    },
  };
}

export type IconFetcher = ReturnType<typeof createIconFetcher>;
