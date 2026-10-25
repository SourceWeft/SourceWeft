import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { db, workspaceMcpOAuthSessions } from "@sourceweft/db";
import {
  decryptTeamSecret,
  encryptTeamSecret,
} from "../../shared/team-secrets";
import type { McpOAuthStore } from "./oauth-provider";

export type McpOAuthScope = {
  teamId: string;
  workspaceId: string;
  installId: string;
  userId: string;
};

type SessionPatch = {
  issuer?: string;
  encryptedClientInfo?: string | null;
  encryptedTokens?: string | null;
  codeVerifier?: string | null;
  state?: string | null;
  pendingExpiresAt?: Date | null;
  pendingReturnTo?: string | null;
};

async function loadSessionRow(scope: McpOAuthScope) {
  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(
      and(
        eq(workspaceMcpOAuthSessions.installId, scope.installId),
        eq(workspaceMcpOAuthSessions.userId, scope.userId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Insert-or-update the (install, user) session, touching only the fields present
 * in `patch` so a code-verifier write can't clobber stored tokens and vice
 * versa.
 */
async function upsertSession(scope: McpOAuthScope, patch: SessionPatch) {
  const now = new Date();
  await db
    .insert(workspaceMcpOAuthSessions)
    .values({
      id: randomUUID(),
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      installId: scope.installId,
      userId: scope.userId,
      issuer: patch.issuer ?? null,
      encryptedClientInfo: patch.encryptedClientInfo ?? null,
      encryptedTokens: patch.encryptedTokens ?? null,
      codeVerifier: patch.codeVerifier ?? null,
      state: patch.state ?? null,
      pendingExpiresAt: patch.pendingExpiresAt ?? null,
      pendingReturnTo: patch.pendingReturnTo ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceMcpOAuthSessions.installId,
        workspaceMcpOAuthSessions.userId,
      ],
      set: {
        ...(patch.issuer !== undefined ? { issuer: patch.issuer } : {}),
        ...(patch.encryptedClientInfo !== undefined
          ? { encryptedClientInfo: patch.encryptedClientInfo }
          : {}),
        ...(patch.encryptedTokens !== undefined
          ? { encryptedTokens: patch.encryptedTokens }
          : {}),
        ...(patch.codeVerifier !== undefined
          ? { codeVerifier: patch.codeVerifier }
          : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.pendingExpiresAt !== undefined
          ? { pendingExpiresAt: patch.pendingExpiresAt }
          : {}),
        ...(patch.pendingReturnTo !== undefined
          ? { pendingReturnTo: patch.pendingReturnTo }
          : {}),
        updatedAt: now,
      },
    });
}

/**
 * DB-backed OAuth store for one (install, user). Client info and tokens are
 * encrypted at rest with the owning team's data key (pre-envelope v1 rows
 * stay readable); the PKCE verifier and state are transient (cleared on
 * callback via clearMcpOAuthTransient).
 */
export function createDbMcpOAuthStore(
  scope: McpOAuthScope,
  issuer: string,
): McpOAuthStore {
  return {
    async loadClientInformation() {
      const row = await loadSessionRow(scope);
      const decrypted = await decryptTeamSecret(
        row?.encryptedClientInfo ?? null,
        scope.teamId,
      );
      return decrypted
        ? (JSON.parse(decrypted) as OAuthClientInformationFull)
        : undefined;
    },
    async saveClientInformation(info) {
      await upsertSession(scope, {
        issuer,
        encryptedClientInfo: await encryptTeamSecret(
          JSON.stringify(info),
          scope.teamId,
        ),
      });
    },
    async loadTokens() {
      const row = await loadSessionRow(scope);
      const decrypted = await decryptTeamSecret(
        row?.encryptedTokens ?? null,
        scope.teamId,
      );
      return decrypted ? (JSON.parse(decrypted) as OAuthTokens) : undefined;
    },
    async saveTokens(tokens) {
      await upsertSession(scope, {
        issuer,
        encryptedTokens: await encryptTeamSecret(
          JSON.stringify(tokens),
          scope.teamId,
        ),
      });
    },
    async loadCodeVerifier() {
      const row = await loadSessionRow(scope);
      return row?.codeVerifier ?? undefined;
    },
    async saveCodeVerifier(verifier) {
      await upsertSession(scope, { issuer, codeVerifier: verifier });
    },
    async loadState() {
      const row = await loadSessionRow(scope);
      return row?.state ?? undefined;
    },
    async saveState(state) {
      await upsertSession(scope, { issuer, state });
    },
  };
}

/** How long a started authorization may wait for its callback. */
export const MCP_OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;
/** How long the page the callback returns to may ask to confirm a connection. */
export const MCP_OAUTH_COMPLETION_TTL_MS = 15 * 60_000;

export type McpOAuthPendingAttempt = {
  scope: McpOAuthScope;
  issuer: string | null;
  codeVerifier: string | null;
  returnTo: string | null;
};

/**
 * Record a freshly started attempt as the (install, user)'s one pending
 * attempt, replacing any earlier one: state, PKCE verifier, issuer, expiry and
 * destination are written together, so a superseded callback finds nothing and
 * two concurrent starts can never leave one attempt's state beside the other's
 * verifier.
 */
export async function beginMcpOAuthAttempt(
  scope: McpOAuthScope,
  attempt: {
    issuer: string;
    state: string;
    codeVerifier: string;
    returnTo: string | null;
    now?: Date;
  },
) {
  const now = attempt.now ?? new Date();
  await upsertSession(scope, {
    issuer: attempt.issuer,
    state: attempt.state,
    codeVerifier: attempt.codeVerifier,
    pendingExpiresAt: new Date(now.getTime() + MCP_OAUTH_ATTEMPT_TTL_MS),
    pendingReturnTo: attempt.returnTo,
  });
}

/**
 * Atomically consume the pending attempt for an authorization `state`: the
 * row is locked, the state, verifier and destination are cleared in the same
 * transaction, and the attempt is returned exactly once. An unknown, already
 * consumed or expired state yields null (an expired one is still cleared). The
 * state both authenticates the callback (CSRF) and identifies the
 * (install, user) it was started for.
 */
export async function consumeMcpOAuthAttempt(
  state: string,
  now: Date = new Date(),
): Promise<McpOAuthPendingAttempt | null> {
  if (!state) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(workspaceMcpOAuthSessions)
      .where(eq(workspaceMcpOAuthSessions.state, state))
      .limit(1)
      .for("update");
    if (!row) {
      return null;
    }
    await tx
      .update(workspaceMcpOAuthSessions)
      .set({
        state: null,
        codeVerifier: null,
        pendingExpiresAt: null,
        pendingReturnTo: null,
        updatedAt: now,
      })
      .where(eq(workspaceMcpOAuthSessions.id, row.id));
    // A row written before expiry existed has none: treat it as expired.
    if (!row.pendingExpiresAt || row.pendingExpiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return {
      scope: {
        teamId: row.teamId,
        workspaceId: row.workspaceId,
        installId: row.installId,
        userId: row.userId,
      },
      issuer: row.issuer ?? null,
      codeVerifier: row.codeVerifier ?? null,
      returnTo: row.pendingReturnTo ?? null,
    };
  });
}

/**
 * Remember that this (install, user) just connected and return a random,
 * non-secret reference for it. The callback puts the reference in its redirect;
 * the page asks the API to resolve it for the signed-in user, so a bare
 * `?mcpOAuth=connected` proves nothing.
 */
export async function recordMcpOAuthCompletion(
  scope: McpOAuthScope,
  now: Date = new Date(),
) {
  const ref = randomBytes(16).toString("hex");
  await db
    .update(workspaceMcpOAuthSessions)
    .set({ completionRef: ref, completionAt: now, updatedAt: now })
    .where(
      and(
        eq(workspaceMcpOAuthSessions.installId, scope.installId),
        eq(workspaceMcpOAuthSessions.userId, scope.userId),
      ),
    );
  return ref;
}

/**
 * The (workspace, install) a completion reference was issued for, only to the
 * member it was issued to, only while still connected and recent.
 */
export async function findMcpOAuthCompletion(input: {
  userId: string;
  ref: string;
  now?: Date;
}): Promise<{ workspaceId: string; installId: string } | null> {
  if (!/^[0-9a-f]{32}$/.test(input.ref)) {
    return null;
  }
  const now = input.now ?? new Date();
  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(
      and(
        eq(workspaceMcpOAuthSessions.completionRef, input.ref),
        eq(workspaceMcpOAuthSessions.userId, input.userId),
        isNotNull(workspaceMcpOAuthSessions.encryptedTokens),
        gt(
          workspaceMcpOAuthSessions.completionAt,
          new Date(now.getTime() - MCP_OAUTH_COMPLETION_TTL_MS),
        ),
      ),
    )
    .limit(1);
  return row ? { workspaceId: row.workspaceId, installId: row.installId } : null;
}

/** Whether a user has a usable (token-bearing) OAuth session for an install. */
export async function getMcpOAuthStatus(scope: McpOAuthScope): Promise<{
  connected: boolean;
  issuer: string | null;
}> {
  const row = await loadSessionRow(scope);
  return {
    connected: Boolean(row?.encryptedTokens),
    issuer: row?.issuer ?? null,
  };
}

/**
 * Install ids this user has a token-bearing (connected) OAuth session for.
 * Batched to overlay per-user credential status over an install list in one
 * query.
 */
export async function listUserConnectedOAuthInstallIds(input: {
  userId: string;
  installIds: string[];
}) {
  if (input.installIds.length === 0) {
    return new Set<string>();
  }
  const rows = await db
    .select({ installId: workspaceMcpOAuthSessions.installId })
    .from(workspaceMcpOAuthSessions)
    .where(
      and(
        eq(workspaceMcpOAuthSessions.userId, input.userId),
        inArray(workspaceMcpOAuthSessions.installId, input.installIds),
        isNotNull(workspaceMcpOAuthSessions.encryptedTokens),
      ),
    );
  return new Set(rows.map((row) => row.installId));
}

/** Clear the single-use PKCE verifier + state once a callback completes. */
export async function clearMcpOAuthTransient(scope: McpOAuthScope) {
  await db
    .update(workspaceMcpOAuthSessions)
    .set({
      codeVerifier: null,
      state: null,
      pendingExpiresAt: null,
      pendingReturnTo: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceMcpOAuthSessions.installId, scope.installId),
        eq(workspaceMcpOAuthSessions.userId, scope.userId),
      ),
    );
}

/**
 * Remove EVERY user's OAuth session for an install. Called when the install's
 * endpoint URL changes (re-install with a different endpoint): tokens were
 * consented for the old endpoint's service, and continuing to attach them as
 * Bearer to a new endpoint would hand every connected user's token to whatever
 * the new URL points at (confused-deputy). Users re-connect against the new
 * endpoint instead.
 */
export async function deleteMcpOAuthSessionsForInstall(installId: string) {
  await db
    .delete(workspaceMcpOAuthSessions)
    .where(eq(workspaceMcpOAuthSessions.installId, installId));
}

/** Remove a user's OAuth session for an install (disconnect / revoke locally). */
export async function deleteMcpOAuthSession(scope: McpOAuthScope) {
  await db
    .delete(workspaceMcpOAuthSessions)
    .where(
      and(
        eq(workspaceMcpOAuthSessions.installId, scope.installId),
        eq(workspaceMcpOAuthSessions.userId, scope.userId),
      ),
    );
}
