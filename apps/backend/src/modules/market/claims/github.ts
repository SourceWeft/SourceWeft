import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { githubFetch, githubHeaders } from "../parser/github";

/**
 * GitHub claims (Issue #367, W7). Two very different reads:
 *
 * - who an account is (`GET /users/{login}`): public data, read with the
 *   platform's usual GitHub headers, compared by id with the member's linked
 *   account — the same proof the skill claims use;
 * - whether the member is an admin of an organization
 *   (`GET /user/memberships/orgs/{org}`): read with the MEMBER's own OAuth
 *   token from their GitHub link, never a platform token. The platform's
 *   GitHub sign-in asks for `read:user user:email`; this endpoint needs
 *   `read:org`, which the member grants by re-linking GitHub with that
 *   scope. The token is used for this one request and never stored again.
 */

export type GitHubAccountFacts = {
  id: string;
  login: string;
  type: "User" | "Organization";
};

export class GitHubUnavailableError extends Error {
  constructor(message = "GitHub could not be reached to verify this claim") {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

/** Public facts about a login; null when GitHub has no such account. */
export async function fetchGitHubAccount(
  login: string,
): Promise<GitHubAccountFacts | null> {
  let response: Response;
  try {
    response = await githubFetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      githubHeaders(),
    );
  } catch {
    throw new GitHubUnavailableError();
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new GitHubUnavailableError();
  const data = (await response.json().catch(() => null)) as {
    id?: unknown;
    login?: unknown;
    type?: unknown;
  } | null;
  if (
    !data ||
    (typeof data.id !== "number" && typeof data.id !== "string") ||
    typeof data.login !== "string" ||
    (data.type !== "User" && data.type !== "Organization")
  ) {
    throw new GitHubUnavailableError();
  }
  return { id: String(data.id), login: data.login.toLowerCase(), type: data.type };
}

export type LinkedGithubAccount = {
  /** GitHub's numeric user id, as better-auth stores it in `accountId`. */
  accountId: string;
  accessToken: string | null;
  scope: string | null;
};

/**
 * The GitHub account the member linked through sign-in (better-auth's
 * `account` table). The access token is the member's own; it leaves this
 * process only in a request to GitHub on the member's behalf.
 */
export async function getLinkedGithubAccount(
  userId: string,
): Promise<LinkedGithubAccount | null> {
  const result = await db.execute<{
    accountId: string;
    accessToken: string | null;
    scope: string | null;
  }>(sql`
    select "accountId", "accessToken", "scope" from "account"
    where "userId" = ${userId} and "providerId" = 'github'
    order by "createdAt" asc
    limit 1
  `);
  const row = result.rows?.[0];
  return row
    ? {
        accountId: row.accountId,
        accessToken: row.accessToken ?? null,
        scope: row.scope ?? null,
      }
    : null;
}

export type OrgMembershipAnswer =
  | { kind: "member"; state: string; role: string }
  | { kind: "not_member" }
  /** The token lacks `read:org`: GitHub will not say. */
  | { kind: "scope" };

const ORG_SCOPES = ["read:org", "write:org", "admin:org"];

function tokenHasOrgScope(scopeHeader: string | null): boolean {
  if (scopeHeader === null) return true; // unknown: let the status decide
  const granted = scopeHeader.split(",").map((scope) => scope.trim());
  return granted.some((scope) => ORG_SCOPES.includes(scope));
}

/**
 * The member's own membership in `org`, read with their token. 403 is
 * GitHub's answer for a token without `read:org`; a 404 means no visible
 * membership, which — when the token has the scope — is "not a member".
 */
export async function fetchGitHubOrgMembership(
  org: string,
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OrgMembershipAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "sourceweft-claims",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new GitHubUnavailableError();
  }
  const scopes = response.headers.get("x-oauth-scopes");
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "scope" };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return tokenHasOrgScope(scopes) ? { kind: "not_member" } : { kind: "scope" };
  }
  if (!response.ok) throw new GitHubUnavailableError();
  const data = (await response.json().catch(() => null)) as {
    state?: unknown;
    role?: unknown;
  } | null;
  if (!data || typeof data.state !== "string" || typeof data.role !== "string") {
    throw new GitHubUnavailableError();
  }
  return { kind: "member", state: data.state, role: data.role };
}

/** GitHub's organization roles: `admin` is an owner; `member` is not. */
export function isOrganizationOwner(answer: OrgMembershipAnswer): boolean {
  return (
    answer.kind === "member" &&
    answer.state === "active" &&
    answer.role === "admin"
  );
}
