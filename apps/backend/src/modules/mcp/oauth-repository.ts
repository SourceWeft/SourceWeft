import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { db, workspaceMcpOAuthSessions } from "@sourceweft/db";
import { config } from "../../shared/config";
import { decryptSecret, encryptSecret } from "../../shared/secrets";
import type { McpOAuthStore } from "./oauth-provider";

function encryptionSecret() {
  return config.modelGatewayEncryptionSecret;
}

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
        updatedAt: now,
      },
    });
}

/**
 * DB-backed OAuth store for one (install, user). Client info and tokens are
 * encrypted at rest with the shared secret; the PKCE verifier and state are
 * transient (cleared on callback via clearMcpOAuthTransient).
 */
export function createDbMcpOAuthStore(
  scope: McpOAuthScope,
  issuer: string,
): McpOAuthStore {
  return {
    async loadClientInformation() {
      const row = await loadSessionRow(scope);
      const decrypted = decryptSecret(
        row?.encryptedClientInfo ?? null,
        encryptionSecret(),
      );
      return decrypted
        ? (JSON.parse(decrypted) as OAuthClientInformationFull)
        : undefined;
    },
    async saveClientInformation(info) {
      await upsertSession(scope, {
        issuer,
        encryptedClientInfo: encryptSecret(
          JSON.stringify(info),
          encryptionSecret(),
        ),
      });
    },
    async loadTokens() {
      const row = await loadSessionRow(scope);
      const decrypted = decryptSecret(
        row?.encryptedTokens ?? null,
        encryptionSecret(),
      );
      return decrypted ? (JSON.parse(decrypted) as OAuthTokens) : undefined;
    },
    async saveTokens(tokens) {
      await upsertSession(scope, {
        issuer,
        encryptedTokens: encryptSecret(
          JSON.stringify(tokens),
          encryptionSecret(),
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

/**
 * Resolve the pending session for an authorization `state` (CSRF check on
 * callback). The state is a single-use nonce we persisted during authorize, so a
 * match both authenticates the callback and tells us which (install, user) it is
 * for.
 */
export async function findMcpOAuthSessionByState(state: string): Promise<{
  scope: McpOAuthScope;
  issuer: string | null;
} | null> {
  if (!state) {
    return null;
  }
  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(eq(workspaceMcpOAuthSessions.state, state))
    .limit(1);
  if (!row) {
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
  };
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
    .set({ codeVerifier: null, state: null, updatedAt: new Date() })
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
