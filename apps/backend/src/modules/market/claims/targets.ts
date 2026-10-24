import { createHash, randomBytes } from "node:crypto";
import {
  MCP_CLAIM_DNS_LABEL,
  MCP_CLAIM_TOKEN_TTL_DAYS,
  MCP_CLAIM_WELL_KNOWN_PATH,
} from "@sourceweft/contracts";

/**
 * Who could claim a catalog entry (Issue #367, W7): the GitHub account or
 * organization it is published under, and the domain of its namespace. Pure;
 * the checks against GitHub, DNS and the web are in ./github.ts and
 * ./domain-verify.ts.
 */

export type McpClaimTargets = {
  /** The GitHub login the entry belongs to, lowercased; null when none. */
  github: { owner: string; source: "namespace" | "repository" } | null;
  /** The namespace domain (`com.notion/mcp` → `notion.com`); null when none. */
  domain: string | null;
};

// GitHub's own rules: a login is alphanumerics and single inner hyphens, at
// most 39 characters.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// One DNS label: letters, digits and inner hyphens, at most 63 characters.
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The last label of a registrable name is alphabetic (no IP literals).
const DNS_TLD_RE = /^[a-z]{2,63}$/;
// Names that never belong to a publisher on the public internet.
const RESERVED_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "test",
  "example",
  "invalid",
  "arpa",
  "home",
  "lan",
  "corp",
]);

/** The namespace part of an identifier: everything before the first `/`. */
export function identifierNamespace(identifier: string): string {
  return identifier.split("/")[0] ?? "";
}

/** `io.github.<owner>/…` → `owner`; null for any other namespace. */
export function githubOwnerOfIdentifier(identifier: string): string | null {
  const match = identifierNamespace(identifier).match(/^io\.github\.(.+)$/i);
  const owner = match?.[1];
  return owner && GITHUB_LOGIN_RE.test(owner) ? owner.toLowerCase() : null;
}

/** `https://github.com/<owner>/<repo>` → `owner`; null for any other URL. */
export function githubOwnerOfRepoUrl(
  repoUrl: string | null | undefined,
): string | null {
  if (!repoUrl) return null;
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !GITHUB_LOGIN_RE.test(owner)) return null;
  return owner.toLowerCase();
}

/**
 * The domain a reverse-DNS namespace names: `com.notion` → `notion.com`.
 * `io.github.*` namespaces are GitHub accounts, not domains. Null for a
 * namespace that is not a plausible public registrable name (fewer than two
 * labels, an IP literal, a reserved or local top-level label), so the
 * platform never issues a claim for — or fetches from — such a host.
 */
export function namespaceDomain(identifier: string): string | null {
  const namespace = identifierNamespace(identifier).toLowerCase();
  if (!namespace || /^io\.github\./.test(namespace)) return null;
  const labels = namespace.split(".");
  if (labels.length < 2 || labels.length > 10) return null;
  if (!labels.every((label) => DNS_LABEL_RE.test(label))) return null;
  // Reverse-DNS: the first label of the namespace is the top-level domain.
  const tld = labels[0]!;
  if (!DNS_TLD_RE.test(tld) || RESERVED_TLDS.has(tld)) return null;
  return labels.reverse().join(".");
}

export function claimTargetsFor(input: {
  identifier: string;
  repoUrl: string | null | undefined;
}): McpClaimTargets {
  const namespaceOwner = githubOwnerOfIdentifier(input.identifier);
  const repoOwner = githubOwnerOfRepoUrl(input.repoUrl);
  return {
    github: namespaceOwner
      ? { owner: namespaceOwner, source: "namespace" }
      : repoOwner
        ? { owner: repoOwner, source: "repository" }
        : null,
    domain: namespaceDomain(input.identifier),
  };
}

// --- Tokens ----------------------------------------------------------------

const TOKEN_PREFIX = "sourceweft-claim-";

/** A fresh claim token: a recognizable prefix and 128 random bits, hex. */
export function newClaimToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
}

/** Only the hash is stored; the token is shown once, when the claim starts. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function claimTokenExpiry(now = new Date()): Date {
  return new Date(now.getTime() + MCP_CLAIM_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
}

export function dnsRecordName(domain: string): string {
  return `${MCP_CLAIM_DNS_LABEL}.${domain}`;
}

export function wellKnownUrl(domain: string): string {
  return `https://${domain}${MCP_CLAIM_WELL_KNOWN_PATH}`;
}

/**
 * Whether published text carries the token: as a whole line of a file, or as
 * a whole TXT record — exactly, with only surrounding whitespace and quotes
 * allowed. A token inside other text does not count.
 */
export function textCarriesToken(text: string, tokenHash: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const candidate = line.trim().replace(/^"(.*)"$/, "$1").trim();
    return (
      candidate.startsWith(TOKEN_PREFIX) && hashClaimToken(candidate) === tokenHash
    );
  });
}
