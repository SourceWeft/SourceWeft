import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/** Per-member static credentials against real PostgreSQL. */

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let installIds: [string, string, string];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("mcp_credentials");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(async () => {
  teamId = randomUUID();
  workspaceId = randomUUID();
  installIds = [randomUUID(), randomUUID(), randomUUID()];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "MCP credential repository test",
    slug: `mcp-credentials-${workspaceId}`,
  });
  await schema.db.insert(schema.workspaceMcpInstalls).values(
    installIds.map((id) => ({
      id,
      teamId,
      workspaceId,
      name: "MCP credential repository test install",
      transport: "streamable_http" as const,
      authType: "oauth" as const,
    })),
  );
});

function credential(installId: string, userId: string) {
  return { teamId, workspaceId, installId, userId, configuredBy: userId };
}

test("only credentials that carry a secret count as a member's static credential", async () => {
  const [bearerInstall, keyInstall, noneInstall] = installIds;
  await repository.upsertWorkspaceMcpCredential({
    ...credential(bearerInstall, "member"),
    authType: "bearer",
    encryptedSecret: "secret",
  });
  await repository.upsertWorkspaceMcpCredential({
    ...credential(keyInstall, "member"),
    authType: "api_key_header",
    encryptedSecret: "secret",
    headerName: "x-api-key",
  });
  await repository.upsertWorkspaceMcpCredential({
    ...credential(noneInstall, "member"),
    authType: "none",
  });
  await repository.upsertWorkspaceMcpCredential({
    ...credential(noneInstall, "other"),
    authType: "bearer",
    encryptedSecret: "secret",
  });

  const ids = await repository.listUserCredentialInstallIds({
    teamId,
    workspaceId,
    userId: "member",
    installIds,
  });

  assert.deepEqual([...ids].sort(), [bearerInstall, keyInstall].sort());
});

test("deleting a member's credential leaves other members and installs alone", async () => {
  const [install, otherInstall] = installIds;
  for (const [installId, userId] of [
    [install, "member"],
    [install, "other"],
    [otherInstall, "member"],
  ] as const) {
    await repository.upsertWorkspaceMcpCredential({
      ...credential(installId, userId),
      authType: "bearer",
      encryptedSecret: "secret",
    });
  }

  await repository.deleteWorkspaceMcpCredential({
    teamId,
    workspaceId,
    installId: install,
    userId: "member",
  });

  const rows = await schema.db
    .select({
      installId: schema.workspaceMcpCredentials.installId,
      userId: schema.workspaceMcpCredentials.userId,
    })
    .from(schema.workspaceMcpCredentials)
    .where(eq(schema.workspaceMcpCredentials.workspaceId, workspaceId));
  assert.deepEqual(
    rows
      .map(
        (row) =>
          `${row.installId === install ? "install" : "otherInstall"}:${row.userId}`,
      )
      .sort(),
    ["install:other", "otherInstall:member"],
  );
});
