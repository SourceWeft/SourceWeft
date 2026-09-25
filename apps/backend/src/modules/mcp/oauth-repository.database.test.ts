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
import { createDbMcpOAuthStore, type McpOAuthScope } from "./oauth-repository";

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
