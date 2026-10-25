import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  teamDataKeys,
  workspaceMcpInstalls,
  workspaceMcpOAuthSessions,
  workspaces,
} from "@sourceweft/db";
import { config } from "../../shared/config";
import { encryptSecret } from "../../shared/secrets";
import { clearTeamDataKeyCache } from "../../shared/team-secrets";
import {
  beginMcpOAuthAttempt,
  consumeMcpOAuthAttempt,
  createDbMcpOAuthStore,
  findMcpOAuthCompletion,
  MCP_OAUTH_ATTEMPT_TTL_MS,
  MCP_OAUTH_COMPLETION_TTL_MS,
  recordMcpOAuthCompletion,
  type McpOAuthScope,
} from "./oauth-repository";

let scope: McpOAuthScope;

beforeEach(async () => {
  scope = {
    teamId: randomUUID(),
    workspaceId: randomUUID(),
    installId: randomUUID(),
    userId: randomUUID(),
  };
  await db.insert(workspaces).values({
    id: scope.workspaceId,
    organizationId: scope.teamId,
    name: "MCP OAuth store test",
    slug: `mcp-oauth-store-${scope.workspaceId}`,
  });
  await db.insert(workspaceMcpInstalls).values({
    id: scope.installId,
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    name: "MCP OAuth store test install",
    transport: "streamable_http",
    authType: "oauth",
  });
});

afterEach(async () => {
  clearTeamDataKeyCache();
  await db.delete(workspaces).where(eq(workspaces.id, scope.workspaceId));
  await db.delete(teamDataKeys).where(eq(teamDataKeys.teamId, scope.teamId));
});

test("saved OAuth tokens are envelope-encrypted with the team's data key", async () => {
  const store = createDbMcpOAuthStore(scope, "https://issuer.example.com");
  const tokens = {
    access_token: "mcp-access-token",
    token_type: "Bearer" as const,
    refresh_token: "mcp-refresh-token",
  };

  await store.saveTokens(tokens);

  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(eq(workspaceMcpOAuthSessions.installId, scope.installId));
  assert.ok(row?.encryptedTokens);
  // At rest: a v2 tenant payload, never master-secret v1 or plaintext.
  assert.ok(row.encryptedTokens.startsWith("v2:"));
  assert.ok(!row.encryptedTokens.includes("mcp-access-token"));

  assert.deepEqual(await store.loadTokens(), tokens);
});

test("saved client information round-trips through a v2 payload", async () => {
  const store = createDbMcpOAuthStore(scope, "https://issuer.example.com");
  const clientInfo = {
    client_id: "dcr-client-id",
    client_secret: "dcr-client-secret",
    redirect_uris: ["https://app.example.com/callback"],
  };

  await store.saveClientInformation(clientInfo);

  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(eq(workspaceMcpOAuthSessions.installId, scope.installId));
  assert.ok(row?.encryptedClientInfo?.startsWith("v2:"));
  assert.deepEqual(await store.loadClientInformation(), clientInfo);
});

test("pre-envelope v1 session rows still load", async () => {
  const legacyTokens = { access_token: "legacy-token", token_type: "Bearer" };
  await db.insert(workspaceMcpOAuthSessions).values({
    id: randomUUID(),
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    installId: scope.installId,
    userId: scope.userId,
    issuer: "https://issuer.example.com",
    encryptedTokens: encryptSecret(
      JSON.stringify(legacyTokens),
      config.modelGatewayEncryptionSecret,
    ),
  });

  const store = createDbMcpOAuthStore(scope, "https://issuer.example.com");
  assert.deepEqual(await store.loadTokens(), legacyTokens);
});

const ISSUER = "https://issuer.example.com";

function attempt(overrides: Partial<Parameters<typeof beginMcpOAuthAttempt>[1]> = {}) {
  return {
    issuer: ISSUER,
    state: `state-${randomUUID()}`,
    codeVerifier: `verifier-${randomUUID()}`,
    returnTo: "/dashboard/mcp/io.github.o%2Fexample",
    ...overrides,
  };
}

test("a started attempt is consumed exactly once with its whole bound context", async () => {
  const started = attempt();
  await beginMcpOAuthAttempt(scope, started);

  const consumed = await consumeMcpOAuthAttempt(started.state);
  assert.deepEqual(consumed, {
    scope,
    issuer: ISSUER,
    codeVerifier: started.codeVerifier,
    returnTo: started.returnTo,
  });
  // A replay of the same state finds nothing, and nothing is left stored.
  assert.equal(await consumeMcpOAuthAttempt(started.state), null);
  const [row] = await db
    .select()
    .from(workspaceMcpOAuthSessions)
    .where(eq(workspaceMcpOAuthSessions.installId, scope.installId));
  assert.equal(row?.state, null);
  assert.equal(row?.codeVerifier, null);
  assert.equal(row?.pendingExpiresAt, null);
  assert.equal(row?.pendingReturnTo, null);
});

test("concurrent callbacks for one state yield one winner", async () => {
  const started = attempt();
  await beginMcpOAuthAttempt(scope, started);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => consumeMcpOAuthAttempt(started.state)),
  );
  assert.equal(results.filter(Boolean).length, 1);
});

test("an expired attempt is refused and cleared", async () => {
  const started = attempt();
  const startedAt = new Date("2026-10-01T00:00:00.000Z");
  await beginMcpOAuthAttempt(scope, { ...started, startedAt });

  const late = new Date(startedAt.getTime() + MCP_OAUTH_ATTEMPT_TTL_MS + 1);
  assert.equal(await consumeMcpOAuthAttempt(started.state, late), null);
  // Cleared by the refusal: even a later in-time lookup cannot revive it.
  assert.equal(
    await consumeMcpOAuthAttempt(started.state, startedAt),
    null,
  );
});

test("an attempt is valid up to, not past, its expiry", async () => {
  const started = attempt();
  const startedAt = new Date("2026-10-01T00:00:00.000Z");
  await beginMcpOAuthAttempt(scope, { ...started, startedAt });
  const justBefore = new Date(startedAt.getTime() + MCP_OAUTH_ATTEMPT_TTL_MS - 1);
  assert.ok(await consumeMcpOAuthAttempt(started.state, justBefore));
});

test("a row from before expiry existed (state without an expiry) is refused", async () => {
  const state = `legacy-${randomUUID()}`;
  await db.insert(workspaceMcpOAuthSessions).values({
    id: randomUUID(),
    ...scope,
    issuer: ISSUER,
    state,
    codeVerifier: "legacy-verifier",
  });
  assert.equal(await consumeMcpOAuthAttempt(state), null);
});

test("a newer attempt for the same member and install supersedes the earlier one", async () => {
  const first = attempt();
  const second = attempt({ returnTo: "/dashboard/mcp" });
  const t0 = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(await beginMcpOAuthAttempt(scope, { ...first, startedAt: t0 }), true);
  assert.equal(
    await beginMcpOAuthAttempt(scope, {
      ...second,
      startedAt: new Date(t0.getTime() + 1_000),
    }),
    true,
  );

  assert.equal(await consumeMcpOAuthAttempt(first.state, t0), null);
  const consumed = await consumeMcpOAuthAttempt(second.state, t0);
  assert.equal(consumed?.returnTo, "/dashboard/mcp");
  assert.equal(consumed?.codeVerifier, second.codeVerifier);
});

test("a start that began earlier can never replace one that began later, however late it finishes", async () => {
  const stalled = attempt({ state: "state-stalled" });
  const newer = attempt({ state: "state-newer" });
  const t0 = new Date("2026-10-01T00:00:00.000Z");
  // B began after A but finished first; A's zombie then tries to record itself.
  assert.equal(
    await beginMcpOAuthAttempt(scope, {
      ...newer,
      startedAt: new Date(t0.getTime() + 5_000),
    }),
    true,
  );
  assert.equal(
    await beginMcpOAuthAttempt(scope, { ...stalled, startedAt: t0 }),
    false,
  );
  const now = new Date(t0.getTime() + 6_000);
  assert.equal(await consumeMcpOAuthAttempt("state-stalled", now), null);
  assert.equal((await consumeMcpOAuthAttempt("state-newer", now))?.scope.userId, scope.userId);
});

test("a start that began before a connection completed cannot record an attempt after it", async () => {
  const store = createDbMcpOAuthStore(scope, ISSUER);
  await store.saveTokens({ access_token: "t", token_type: "Bearer" });
  const t0 = new Date("2026-10-01T00:00:00.000Z");
  await recordMcpOAuthCompletion(scope, new Date(t0.getTime() + 2_000));
  const zombie = attempt({ state: "state-zombie" });
  assert.equal(await beginMcpOAuthAttempt(scope, { ...zombie, startedAt: t0 }), false);
  assert.equal(await consumeMcpOAuthAttempt("state-zombie", t0), null);
  // A start that begins after the completion is fine.
  assert.equal(
    await beginMcpOAuthAttempt(scope, {
      ...attempt(),
      startedAt: new Date(t0.getTime() + 3_000),
    }),
    true,
  );
});

test("two members' attempts on one install do not touch each other", async () => {
  const other: McpOAuthScope = { ...scope, userId: randomUUID() };
  const mine = attempt();
  const theirs = attempt({ returnTo: "/dashboard/chat" });
  await beginMcpOAuthAttempt(scope, mine);
  await beginMcpOAuthAttempt(other, theirs);

  assert.equal((await consumeMcpOAuthAttempt(mine.state))?.scope.userId, scope.userId);
  assert.equal((await consumeMcpOAuthAttempt(theirs.state))?.scope.userId, other.userId);
});

test("starting an attempt keeps the member's stored tokens and client", async () => {
  const store = createDbMcpOAuthStore(scope, ISSUER);
  const tokens = { access_token: "kept", token_type: "Bearer" as const };
  await store.saveTokens(tokens);
  await beginMcpOAuthAttempt(scope, attempt());
  assert.deepEqual(await store.loadTokens(), tokens);
});

test("a completion reference resolves only for its member, while connected and recent", async () => {
  const store = createDbMcpOAuthStore(scope, ISSUER);
  await store.saveTokens({ access_token: "t", token_type: "Bearer" });
  const now = new Date("2026-10-01T00:00:00.000Z");
  const ref = await recordMcpOAuthCompletion(scope, now);

  assert.deepEqual(await findMcpOAuthCompletion({ userId: scope.userId, ref, now }), {
    workspaceId: scope.workspaceId,
    installId: scope.installId,
  });
  // Someone else holding the (non-secret) reference learns nothing.
  assert.equal(await findMcpOAuthCompletion({ userId: randomUUID(), ref, now }), null);
  assert.equal(await findMcpOAuthCompletion({ userId: scope.userId, ref: "0".repeat(32), now }), null);
  assert.equal(await findMcpOAuthCompletion({ userId: scope.userId, ref: "not-a-ref", now }), null);
  // Too old.
  assert.equal(
    await findMcpOAuthCompletion({
      userId: scope.userId,
      ref,
      now: new Date(now.getTime() + MCP_OAUTH_COMPLETION_TTL_MS + 1),
    }),
    null,
  );
});

test("a completion reference stops resolving once the connection is gone", async () => {
  const store = createDbMcpOAuthStore(scope, ISSUER);
  await store.saveTokens({ access_token: "t", token_type: "Bearer" });
  const ref = await recordMcpOAuthCompletion(scope);
  await db
    .update(workspaceMcpOAuthSessions)
    .set({ encryptedTokens: null })
    .where(eq(workspaceMcpOAuthSessions.installId, scope.installId));
  assert.equal(await findMcpOAuthCompletion({ userId: scope.userId, ref }), null);
});
