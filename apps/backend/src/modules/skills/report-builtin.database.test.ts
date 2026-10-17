import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { getBuiltinSkillBySlug } from "./builtin";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let database: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("report_install");
  process.env.DATABASE_URL = isolated.url;
  database = await import("@sourceweft/db");
  repository = await import("./repository");
}, 120_000);

afterAll(async () => {
  if (database) await database.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

test("a fresh workspace can opt into the public report builtin without a pre-existing entitlement", async () => {
  const skill = await getBuiltinSkillBySlug("report");
  assert.ok(skill);
  await repository.syncBuiltinSkillMetadata({
    slug: skill.slug,
    displayName: skill.displayName,
    description: skill.description,
    visibility: skill.visibility,
    version: skill.version,
    storagePointer: skill.storagePointer,
    contentHash: skill.contentHash,
    manifestJson: skill.manifestJson,
  });
  const candidates = await repository.findInstallableSkillsByName({
    teamId: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    name: "report",
  });
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.equal(candidate.definition.sourceType, "builtin");
  assert.equal(candidate.definition.visibility, "public");
  assert.equal(candidate.version.manifestJson.managed, true);
  assert.equal(candidate.version.manifestJson.defaultEnabled, false);
  assert.equal(
    candidate.enabled,
    null,
    "discovery must not silently install the skill",
  );
});
