import { randomUUID } from "node:crypto";
import type {
  McpClaim,
  McpClaimAdminRow,
  McpClaimOverview,
  McpOwnerOverrides,
  McpOwnerOverridesInput,
  RevokeMcpClaimResponse,
  StartMcpClaimResponse,
  VerifyMcpClaimResponse,
} from "@sourceweft/contracts";
import type { SubmitMarketMcpOwnerToolsRequest } from "@sourceweft/market-contracts";
import { McpClaimError } from "./errors";
import {
  DomainLookupError,
  defaultDomainLookup,
  verifyDnsTxt,
  verifyWellKnown,
  type DomainLookup,
} from "./domain-verify";
import {
  GitHubUnavailableError,
  fetchGitHubAccount,
  fetchGitHubOrgMembership,
  getLinkedGithubAccount,
  isOrganizationOwner,
  type GitHubAccountFacts,
  type LinkedGithubAccount,
  type OrgMembershipAnswer,
} from "./github";
import { ownerOverrideValues, ownerSubmittedTools } from "./overrides";
import {
  findClaimById,
  findClaimableServer,
  findOwnerOverridesRow,
  findServerIdentifier,
  findVerifiedClaim,
  hasVerifiedClaim,
  insertVerifiedClaim,
  listClaimsForAdmin,
  listViewerClaims,
  markClaimRevoked,
  markClaimVerified,
  recordClaimError,
  replacePendingClaim,
  upsertOwnerOverrideValues,
  upsertOwnerTools,
  type ClaimableServer,
  type McpClaimRow,
} from "./repository";
import {
  claimTargetsFor,
  claimTokenExpiry,
  dnsRecordName,
  hashClaimToken,
  newClaimToken,
  wellKnownUrl,
} from "./targets";
import type { McpOwnerOverridesRow } from "./overrides";

/**
 * Owner claims and corrections for catalog MCP servers (Issue #367, W7).
 *
 * A claim is the member's own: started, verified and given up by them. The
 * platform decides nothing on a guess — a GitHub claim is decided by GitHub's
 * live answer, a domain claim by what the domain actually publishes. Several
 * members may each verify a claim on the same server (an organization's
 * admins, say); each of them may then correct the listing, and the last
 * write wins. A market admin can revoke any claim.
 */

export type McpClaimGitHub = {
  fetchAccount: (login: string) => Promise<GitHubAccountFacts | null>;
  getLinkedAccount: (userId: string) => Promise<LinkedGithubAccount | null>;
  fetchOrgMembership: (
    org: string,
    accessToken: string,
  ) => Promise<OrgMembershipAnswer>;
};

export type McpClaimDeps = {
  github: McpClaimGitHub;
  domain: DomainLookup;
  now: () => Date;
};

export const defaultMcpClaimDeps: McpClaimDeps = {
  github: {
    fetchAccount: fetchGitHubAccount,
    getLinkedAccount: getLinkedGithubAccount,
    fetchOrgMembership: (org, token) => fetchGitHubOrgMembership(org, token),
  },
  domain: defaultDomainLookup,
  now: () => new Date(),
};

const ADMIN_LIST_LIMIT = 200;

// --- Errors ----------------------------------------------------------------

function entryNotFound(): McpClaimError {
  return new McpClaimError(
    404,
    "MCP_CLAIM_ENTRY_NOT_FOUND",
    "No public catalog entry has that identifier",
  );
}

function claimNotFound(): McpClaimError {
  return new McpClaimError(404, "MCP_CLAIM_NOT_FOUND", "No such claim");
}

function claimRequired(): McpClaimError {
  return new McpClaimError(
    403,
    "MCP_CLAIM_REQUIRED",
    "Only a verified owner of this server may change its listing",
  );
}

function githubUnavailable(): McpClaimError {
  return new McpClaimError(
    503,
    "MCP_CLAIM_GITHUB_UNAVAILABLE",
    "GitHub could not be reached to verify this claim; try again shortly",
  );
}

// --- Views -----------------------------------------------------------------

function toClaim(row: McpClaimRow, identifier: string): McpClaim {
  return {
    id: row.id,
    identifier,
    method: row.method,
    status: row.status,
    target: row.target,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastError: row.lastError ?? null,
  };
}

function toOverrides(
  server: ClaimableServer,
  row: McpOwnerOverridesRow | null,
): McpOwnerOverrides {
  const tools = row ? ownerSubmittedTools(row.toolsJson) : [];
  return {
    identifier: server.identifier,
    values: row ? ownerOverrideValues(row.overridesJson) : {},
    tools:
      row && tools.length > 0 && row.toolsSubmittedAt
        ? { count: tools.length, submittedAt: row.toolsSubmittedAt.toISOString() }
        : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

async function requireServer(identifier: string): Promise<ClaimableServer> {
  const server = await findClaimableServer(identifier);
  if (!server) throw entryNotFound();
  return server;
}

/** Where the entry stands for the signed-in viewer. */
export async function getMcpClaimOverview(
  input: { userId: string; identifier: string },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<McpClaimOverview> {
  const server = await requireServer(input.identifier);
  const targets = claimTargetsFor(server);
  const [viewerClaims, claimed, linked] = await Promise.all([
    listViewerClaims(server.id, input.userId),
    hasVerifiedClaim(server.id),
    targets.github ? deps.github.getLinkedAccount(input.userId) : null,
  ]);
  const verified = viewerClaims.find((row) => row.status === "verified");
  const overridesRow = verified ? await findOwnerOverridesRow(server.id) : null;
  return {
    identifier: server.identifier,
    name: server.name,
    claimed,
    claimedByYou: Boolean(verified),
    viewerClaims: viewerClaims.map((row) => toClaim(row, server.identifier)),
    methods: {
      github: targets.github
        ? {
            available: linked !== null,
            owner: targets.github.owner,
            reason: linked ? null : "not_linked",
          }
        : { available: false, owner: null, reason: "not_github_entry" },
      domain: { available: targets.domain !== null, domain: targets.domain },
    },
    overrides: verified ? toOverrides(server, overridesRow) : null,
  };
}

// --- Claiming --------------------------------------------------------------

/**
 * Proves the member controls the GitHub login the entry is published under.
 * A personal account: the linked account IS that account (by id). An
 * organization: the member is one of its owners (`admin` role), read with
 * their own token. Throws the error the member sees; returns on success.
 */
async function assertGithubOwnership(
  input: { userId: string; owner: string },
  github: McpClaimGitHub,
): Promise<void> {
  const linked = await github.getLinkedAccount(input.userId);
  if (!linked) {
    throw new McpClaimError(
      409,
      "MCP_CLAIM_GITHUB_NOT_LINKED",
      "Link the GitHub account this server is published under first",
    );
  }
  let facts: GitHubAccountFacts | null;
  try {
    facts = await github.fetchAccount(input.owner);
  } catch (error) {
    if (error instanceof GitHubUnavailableError) throw githubUnavailable();
    throw error;
  }
  if (!facts) {
    throw new McpClaimError(
      409,
      "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH",
      `GitHub has no account named ${input.owner}`,
    );
  }
  if (facts.type === "User") {
    if (facts.id !== linked.accountId) {
      throw new McpClaimError(
        403,
        "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH",
        `Your linked GitHub account is not ${facts.login}`,
      );
    }
    return;
  }
  if (!linked.accessToken) {
    throw new McpClaimError(
      409,
      "MCP_CLAIM_GITHUB_ORG_SCOPE",
      "Re-link GitHub with organization read access so your membership can be checked",
    );
  }
  let membership: OrgMembershipAnswer;
  try {
    membership = await github.fetchOrgMembership(facts.login, linked.accessToken);
  } catch (error) {
    if (error instanceof GitHubUnavailableError) throw githubUnavailable();
    throw error;
  }
  if (membership.kind === "scope") {
    throw new McpClaimError(
      409,
      "MCP_CLAIM_GITHUB_ORG_SCOPE",
      "Your GitHub link cannot read organization membership; re-link GitHub with organization read access",
    );
  }
  if (!isOrganizationOwner(membership)) {
    throw new McpClaimError(
      403,
      "MCP_CLAIM_GITHUB_ORG_ROLE",
      `Only an owner of the ${facts.login} organization can claim this server`,
    );
  }
}

/**
 * Starts a claim. GitHub is decided at once: verified, or refused with
 * nothing written. A domain method writes a pending claim and answers with
 * the token to publish — the one time it is shown.
 */
export async function startMcpClaim(
  input: {
    userId: string;
    identifier: string;
    method: "github" | "dns_txt" | "well_known";
  },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<StartMcpClaimResponse> {
  const server = await requireServer(input.identifier);
  const existing = await findVerifiedClaim(server.id, input.userId);
  if (existing) {
    return { claim: toClaim(existing, server.identifier), instructions: null };
  }
  const targets = claimTargetsFor(server);
  const now = deps.now();

  if (input.method === "github") {
    if (!targets.github) throw methodUnavailable("GitHub");
    await assertGithubOwnership(
      { userId: input.userId, owner: targets.github.owner },
      deps.github,
    );
    const row = await insertVerifiedClaim({
      id: randomUUID(),
      serverId: server.id,
      userId: input.userId,
      method: "github",
      status: "verified",
      target: targets.github.owner,
      createdAt: now,
      verifiedAt: now,
    });
    return { claim: toClaim(row, server.identifier), instructions: null };
  }

  if (!targets.domain) throw methodUnavailable("domain");
  const token = newClaimToken();
  const expiresAt = claimTokenExpiry(now);
  const row = await replacePendingClaim({
    id: randomUUID(),
    serverId: server.id,
    userId: input.userId,
    method: input.method,
    status: "pending",
    target: targets.domain,
    tokenHash: hashClaimToken(token),
    expiresAt,
    createdAt: now,
  });
  return {
    claim: toClaim(row, server.identifier),
    instructions: {
      token,
      domain: targets.domain,
      dnsRecordName: dnsRecordName(targets.domain),
      dnsRecordValue: token,
      wellKnownUrl: wellKnownUrl(targets.domain),
      wellKnownBody: token,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

function methodUnavailable(kind: string): McpClaimError {
  return new McpClaimError(
    409,
    "MCP_CLAIM_METHOD_UNAVAILABLE",
    `This server cannot be claimed with the ${kind} method`,
  );
}

/** The member's own claim row, with the identifier it is about. */
async function requireOwnClaim(
  claimId: string,
  userId: string,
): Promise<{ row: McpClaimRow; identifier: string }> {
  const row = await findClaimById(claimId);
  // A claim's existence is not shared with anyone but its holder.
  if (!row || row.userId !== userId) throw claimNotFound();
  const identifier = await identifierOf(row.serverId);
  return { row, identifier };
}

async function identifierOf(serverId: string): Promise<string> {
  return (await findServerIdentifier(serverId)) ?? "";
}

/** Looks the pending claim's token up on the domain now. */
export async function verifyMcpClaim(
  input: { userId: string; claimId: string },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<VerifyMcpClaimResponse> {
  const { row, identifier } = await requireOwnClaim(input.claimId, input.userId);
  if (row.status === "verified") return { claim: toClaim(row, identifier) };
  if (row.status !== "pending" || !row.tokenHash) {
    throw new McpClaimError(
      409,
      "MCP_CLAIM_NOT_PENDING",
      "This claim is not waiting for verification",
    );
  }
  const now = deps.now();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    await recordClaimError(row.id, "expired");
    throw new McpClaimError(
      409,
      "MCP_CLAIM_EXPIRED",
      "This claim's token has expired; start the claim again for a new one",
    );
  }
  let verdict: "verified" | "not_found";
  try {
    verdict =
      row.method === "dns_txt"
        ? await verifyDnsTxt(row.target, row.tokenHash, deps.domain)
        : await verifyWellKnown(row.target, row.tokenHash, deps.domain);
  } catch (error) {
    if (error instanceof DomainLookupError) {
      await recordClaimError(row.id, error.message);
      throw new McpClaimError(
        503,
        "MCP_CLAIM_LOOKUP_FAILED",
        `${error.message}; try again shortly`,
      );
    }
    throw error;
  }
  if (verdict === "not_found") {
    const where =
      row.method === "dns_txt"
        ? `no TXT record at ${dnsRecordName(row.target)} carries the token`
        : `${wellKnownUrl(row.target)} does not carry the token`;
    await recordClaimError(row.id, where);
    throw new McpClaimError(
      409,
      "MCP_CLAIM_TOKEN_NOT_FOUND",
      `The token was not found: ${where}`,
    );
  }
  const verified = await markClaimVerified(row.id, now);
  if (!verified) {
    // Raced with itself: read back whatever the row is now.
    const current = await findClaimById(row.id);
    if (!current) throw claimNotFound();
    return { claim: toClaim(current, identifier) };
  }
  return { claim: toClaim(verified, identifier) };
}

/** The owner gives a claim up (pending or verified). Overrides stay stored. */
export async function revokeMcpClaim(
  input: { userId: string; claimId: string },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<RevokeMcpClaimResponse> {
  const { row, identifier } = await requireOwnClaim(input.claimId, input.userId);
  const revoked =
    (await markClaimRevoked({
      claimId: row.id,
      revokedBy: input.userId,
      now: deps.now(),
    })) ?? row;
  return { claim: toClaim(revoked, identifier) };
}

// --- Admin -----------------------------------------------------------------

export async function adminRevokeMcpClaim(
  input: { adminUserId: string; claimId: string },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<RevokeMcpClaimResponse> {
  const row = await findClaimById(input.claimId);
  if (!row) throw claimNotFound();
  const identifier = await identifierOf(row.serverId);
  const revoked =
    (await markClaimRevoked({
      claimId: row.id,
      revokedBy: input.adminUserId,
      now: deps.now(),
    })) ?? row;
  return { claim: toClaim(revoked, identifier) };
}

export async function listMcpClaimsForAdmin(input: {
  identifier?: string | null;
}): Promise<McpClaimAdminRow[]> {
  let serverId: string | null = null;
  if (input.identifier) {
    const server = await findClaimableServer(input.identifier);
    if (!server) return [];
    serverId = server.id;
  }
  const rows = await listClaimsForAdmin({ serverId, limit: ADMIN_LIST_LIMIT });
  const identifiers = new Map<string, string>();
  for (const row of rows) {
    if (!identifiers.has(row.serverId)) {
      identifiers.set(row.serverId, await identifierOf(row.serverId));
    }
  }
  return rows.map((row) => ({
    ...toClaim(row, identifiers.get(row.serverId) ?? ""),
    userId: row.userId,
    revokedBy: row.revokedBy ?? null,
  }));
}

// --- Overrides -------------------------------------------------------------

async function requireVerifiedOwner(input: {
  userId: string;
  identifier: string;
}): Promise<ClaimableServer> {
  const server = await requireServer(input.identifier);
  const claim = await findVerifiedClaim(server.id, input.userId);
  if (!claim) throw claimRequired();
  return server;
}

export async function getMcpOwnerOverrides(input: {
  userId: string;
  identifier: string;
}): Promise<McpOwnerOverrides> {
  const server = await requireVerifiedOwner(input);
  return toOverrides(server, await findOwnerOverridesRow(server.id));
}

/** Replaces the owner's field corrections; null or absent clears a field. */
export async function setMcpOwnerOverrides(
  input: { userId: string; identifier: string; values: McpOwnerOverridesInput },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<McpOwnerOverrides> {
  const server = await requireVerifiedOwner(input);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.values)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    values[key] = value;
  }
  const row = await upsertOwnerOverrideValues({
    serverId: server.id,
    userId: input.userId,
    values,
    now: deps.now(),
  });
  return toOverrides(server, row);
}

/**
 * Stores the tool list the owner generated on their own machine. Only the
 * tools and the file's non-secret facts are kept; the tools are shown with
 * `risk: "unknown"` and `source: "owner-submitted"` (see ./overrides.ts).
 */
export async function setMcpOwnerTools(
  input: {
    userId: string;
    identifier: string;
    submission: SubmitMarketMcpOwnerToolsRequest;
  },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<McpOwnerOverrides> {
  const server = await requireVerifiedOwner(input);
  // Stored as inspected (first of a name wins); the manifest shape — risk
  // unknown, source owner-submitted — is derived on read.
  const seen = new Set<string>();
  const tools = input.submission.tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
  const meta: Record<string, unknown> = {};
  if (input.submission.generatedAt) meta.generatedAt = input.submission.generatedAt;
  if (input.submission.target) meta.target = input.submission.target;
  if (input.submission.serverInfo) meta.serverInfo = input.submission.serverInfo;
  const row = await upsertOwnerTools({
    serverId: server.id,
    userId: input.userId,
    tools: tools.length > 0 ? tools : null,
    meta: tools.length > 0 ? meta : null,
    now: deps.now(),
  });
  return toOverrides(server, row);
}

export async function clearMcpOwnerTools(
  input: { userId: string; identifier: string },
  deps: McpClaimDeps = defaultMcpClaimDeps,
): Promise<McpOwnerOverrides> {
  const server = await requireVerifiedOwner(input);
  const row = await upsertOwnerTools({
    serverId: server.id,
    userId: input.userId,
    tools: null,
    meta: null,
    now: deps.now(),
  });
  return toOverrides(server, row);
}
