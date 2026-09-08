import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let registry: typeof import("./registry");
let service: typeof import("../../service").contentThreadService;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let owner: string;
let other: string;

function code(error: unknown) {
  return (error as { code?: string }).code;
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("personas");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  registry = await import("./registry");
  ({ contentThreadService: service } = await import("../../service"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, owner, other] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Personas",
    slug: workspaceId,
  });
  await schema.db.insert(schema.workspaceMemberships).values([
    { workspaceId, userId: owner, role: "editor", source: "guest" },
    { workspaceId, userId: other, role: "editor", source: "guest" },
  ]);
});

afterEach(async () => {
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  await isolated?.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("a workspace persona is a validated clone that resolves and lists beside the built-ins", async () => {
  const created = await registry.createWorkspacePersona({
    teamId,
    workspaceId,
    userId: owner,
    sourceId: "explore",
    overrides: { name: "Verifier", toolAllowlist: ["search_sources"] },
  });
  assert.match(created.slug, /^persona_/);
  assert.equal(created.trust, "user");
  assert.equal(created.name, "Verifier");
  assert.equal(created.clonedFrom, "explore");
  assert.equal(created.createdBy, owner);
  assert.ok(created.filesystemPermissions?.length);
  assert.deepEqual(created.toolAllowlist, ["search_sources"]);

  const resolved = await registry.resolvePersona({
    teamId,
    workspaceId,
    personaId: created.slug,
  });
  assert.equal(resolved?.name, "Verifier");
  assert.equal(
    (await registry.resolvePersona({ teamId, workspaceId, personaId: "plan" }))
      ?.trust,
    "system",
  );
  assert.equal(
    await registry.resolvePersona({
      teamId,
      workspaceId,
      personaId: "persona_missing",
    }),
    null,
  );
  // Scoped: a row from one workspace never resolves in another.
  assert.equal(
    await registry.resolvePersona({
      teamId,
      workspaceId: randomUUID(),
      personaId: created.slug,
    }),
    null,
  );

  const listed = await registry.listWorkspacePersonas({ teamId, workspaceId });
  assert.deepEqual(
    listed.map((persona) => persona.slug),
    ["general-purpose", "explore", "plan", created.slug],
  );

  const updated = await registry.updateWorkspacePersona({
    teamId,
    workspaceId,
    personaId: created.slug,
    patch: {
      systemPrompt: "Verify every claim against the sources.",
      toolAllowlist: null,
      filesystemPolicy: "default",
    },
  });
  assert.equal(
    updated?.systemPrompt,
    "Verify every claim against the sources.",
  );
  assert.equal(updated?.toolAllowlist, undefined);
  assert.equal(updated?.filesystemPermissions, undefined);
  assert.equal(updated?.name, "Verifier");

  assert.equal(
    await registry.deleteWorkspacePersona({
      teamId,
      workspaceId,
      personaId: created.slug,
    }),
    true,
  );
  assert.equal(
    await registry.resolvePersona({
      teamId,
      workspaceId,
      personaId: created.slug,
    }),
    null,
  );
  assert.equal(
    await registry.deleteWorkspacePersona({
      teamId,
      workspaceId,
      personaId: created.slug,
    }),
    false,
  );
});

test("the service lets the creator or a workspace admin edit, never touches built-ins, and validates edits", async () => {
  const { persona } = await service.createPersona({
    workspaceId,
    userId: owner,
    sourceId: "plan",
    overrides: { name: "Planner two" },
  });
  assert.match(persona.id, /^persona_/);
  assert.equal(persona.trust, "user");
  assert.equal(persona.clonedFrom, "plan");
  assert.equal(persona.filesystemPolicy, "read_only");

  const listed = await service.listPersonas({ workspaceId, userId: other });
  assert.equal(listed.items.length, 4);
  assert.ok(listed.availableTools.includes("search_sources"));

  // Another editor is refused; the creator's partial edit leaves the rest
  // untouched. (Workspace-admin standing needs an organization membership
  // the guest fixtures here do not carry, so it is exercised by the
  // `canAdministerContent` seam this shares with `deleteThread`.)
  await assert.rejects(
    service.updatePersona({
      workspaceId,
      userId: other,
      personaId: persona.id,
      patch: { name: "Hijacked" },
    }),
    (error) => code(error) === "PERSONA_FORBIDDEN",
  );
  await assert.rejects(
    service.deletePersona({
      workspaceId,
      userId: other,
      personaId: persona.id,
    }),
    (error) => code(error) === "PERSONA_FORBIDDEN",
  );
  const byCreator = await service.updatePersona({
    workspaceId,
    userId: owner,
    personaId: persona.id,
    patch: { description: "Edited by its creator" },
  });
  assert.equal(byCreator.persona.description, "Edited by its creator");
  assert.equal(byCreator.persona.name, "Planner two");

  await assert.rejects(
    service.updatePersona({
      workspaceId,
      userId: owner,
      personaId: "explore",
      patch: { name: "Nope" },
    }),
    (error) => code(error) === "PERSONA_READ_ONLY",
  );
  await assert.rejects(
    service.deletePersona({ workspaceId, userId: owner, personaId: "explore" }),
    (error) => code(error) === "PERSONA_READ_ONLY",
  );
  await assert.rejects(
    service.createPersona({
      workspaceId,
      userId: owner,
      sourceId: "explore",
      overrides: { toolAllowlist: ["rm_rf"] },
    }),
    (error) => code(error) === "PERSONA_TOOL_UNKNOWN",
  );
  await assert.rejects(
    service.createPersona({
      workspaceId,
      userId: owner,
      sourceId: "persona_missing",
    }),
    (error) => code(error) === "PERSONA_NOT_FOUND",
  );

  const deleted = await service.deletePersona({
    workspaceId,
    userId: owner,
    personaId: persona.id,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(
    (await service.listPersonas({ workspaceId, userId: owner })).items.length,
    3,
  );
});

test("a thread can be owned by a workspace persona", async () => {
  const { persona } = await service.createPersona({
    workspaceId,
    userId: owner,
    sourceId: "general-purpose",
    overrides: {
      name: "Proof checker",
      modelSettings: { llmProfileAlias: null },
    },
  });
  const { thread } = await service.createThread({
    workspaceId,
    userId: owner,
    personaId: persona.id,
  });
  assert.equal(thread.title, "Proof checker");
  assert.equal(thread.personaId, persona.id);

  // What the turn preparer resolves for this thread is the workspace row.
  const driving = await registry.resolvePersona({
    teamId,
    workspaceId,
    personaId: thread.personaId,
  });
  assert.equal(driving?.trust, "user");
  assert.equal(driving?.name, "Proof checker");

  await assert.rejects(
    service.createThread({
      workspaceId,
      userId: owner,
      personaId: "persona_missing",
    }),
    (error) => code(error) === "PERSONA_NOT_FOUND",
  );
});
