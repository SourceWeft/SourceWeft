import { resolveTxt } from "node:dns/promises";
import { config } from "../../../shared/config";
import { createControlledFetch } from "../../../shared/security/controlled-fetch";
import {
  EndpointPolicyError,
  type EndpointLookup,
  type EndpointPolicy,
} from "../../../shared/security/endpoint-policy";
import { dnsRecordName, textCarriesToken, wellKnownUrl } from "./targets";

/**
 * Domain claims (Issue #367, W7): does the publisher's domain carry the
 * token? Two lookups, each reading exactly one thing and nothing else on the
 * publisher's side — the one outbound request to a publisher domain the
 * catalog makes:
 *
 * - DNS: the TXT records of `_sourceweft-claim.<domain>`;
 * - web: `GET https://<domain>/.well-known/sourceweft-claim`, no redirects
 *   followed, at most 4 KiB read, 5 seconds.
 *
 * The web lookup goes through the platform's controlled fetch, which
 * resolves and checks the address at socket creation with the public
 * endpoint policy: a claimant whose domain points at a private or link-local
 * address gets a denial, not a probe of the deployment's own network.
 *
 * The answer is `verified`, `not_found` (the lookup worked and the token is
 * not there) or a thrown `DomainLookupError` (the lookup itself failed, so
 * nothing is decided).
 */

export class DomainLookupError extends Error {
  constructor(
    readonly method: "dns_txt" | "well_known",
    message: string,
  ) {
    super(message);
    this.name = "DomainLookupError";
  }
}

export type DomainVerdict = "verified" | "not_found";

/** One web lookup's request scope: a fetch, closed when the lookup is done. */
export type DomainFetchScope = {
  fetch: typeof globalThis.fetch;
  close: () => Promise<void>;
};

export type DomainLookup = {
  resolveTxt: (name: string) => Promise<string[][]>;
  openFetch: () => DomainFetchScope;
};

/**
 * The controlled request scope a well-known lookup uses. A publisher domain
 * is never an operator-listed internal origin, so the allow-list is empty.
 */
export function controlledDomainFetch(
  policy: EndpointPolicy = {
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: [],
  },
  lookup?: EndpointLookup,
): DomainFetchScope {
  const scope = createControlledFetch(policy, lookup ? { lookup } : {});
  return { fetch: scope.fetch, close: () => scope.close() };
}

export const defaultDomainLookup: DomainLookup = {
  resolveTxt: (name) => resolveTxt(name),
  openFetch: () => controlledDomainFetch(),
};

export const WELL_KNOWN_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  bodyBytes: 4 * 1024,
});

// DNS answers that mean "no such record", not "DNS is broken".
const DNS_NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export async function verifyDnsTxt(
  domain: string,
  tokenHash: string,
  lookup: DomainLookup = defaultDomainLookup,
): Promise<DomainVerdict> {
  let records: string[][];
  try {
    records = await lookup.resolveTxt(dnsRecordName(domain));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && DNS_NOT_FOUND_CODES.has(code)) {
      return "not_found";
    }
    throw new DomainLookupError(
      "dns_txt",
      `DNS lookup of ${dnsRecordName(domain)} failed`,
    );
  }
  // A TXT record longer than 255 bytes arrives in chunks; join each record.
  const text = records.map((chunks) => chunks.join("")).join("\n");
  return textCarriesToken(text, tokenHash) ? "verified" : "not_found";
}

export async function verifyWellKnown(
  domain: string,
  tokenHash: string,
  lookup: DomainLookup = defaultDomainLookup,
): Promise<DomainVerdict> {
  const url = wellKnownUrl(domain);
  const scope = lookup.openFetch();
  try {
    let response: Response;
    try {
      response = await scope.fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/plain",
          "user-agent": "sourceweft-claim-check",
        },
        signal: AbortSignal.timeout(WELL_KNOWN_LIMITS.timeoutMs),
      });
    } catch (error) {
      // A denied address and a dead host read the same from outside: the
      // lookup failed. Nothing about the deployment's network is told apart.
      throw new DomainLookupError(
        "well_known",
        error instanceof EndpointPolicyError
          ? `${url} is not an address this service may fetch`
          : `${url} could not be fetched`,
      );
    }
    // A redirect is not followed: the token must be at this exact path.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return "not_found";
    }
    const text = await readBounded(response, WELL_KNOWN_LIMITS.bodyBytes);
    return textCarriesToken(text, tokenHash) ? "verified" : "not_found";
  } finally {
    await scope.close().catch(() => undefined);
  }
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = limit - total;
    if (room <= 0) break;
    const slice = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (total >= limit) break;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}
