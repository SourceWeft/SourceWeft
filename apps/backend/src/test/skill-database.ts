import { randomUUID } from "node:crypto";

/**
 * The skill suites run against one shared, pre-migrated database that
 * `scripts/prepare-skill-tests.ts` creates (`sourceweft_skillv6_*`), opted in
 * with RUN_SKILL_DB_TESTS=1. Each file seeds rows under its own tag and
 * deletes only those, so files can share the database and run in parallel.
 */
export const skillDatabaseEnabled = process.env.RUN_SKILL_DB_TESTS === "1";

/**
 * Import the database module after checking the URL really is the skill test
 * database. Call from `beforeAll`; pair with `data.closeDatabase()` in
 * `afterAll`.
 */
export async function loadSkillDatabase() {
  if (
    !new URL(process.env.DATABASE_URL!).pathname.startsWith(
      "/sourceweft_skillv6_",
    )
  )
    throw new Error("Refusing non-isolated database");
  return import("@sourceweft/db");
}

type Data = Awaited<ReturnType<typeof loadSkillDatabase>>;
type DefinitionInsert = Data["skillDefinitions"]["$inferInsert"];
type VersionInsert = Data["skillVersions"]["$inferInsert"];

/** A registry skill definition with fixture defaults; returns its id. */
export async function seedSkillDefinition(
  data: Data,
  overrides: Partial<DefinitionInsert> & { slug: string },
) {
  const id = overrides.id ?? randomUUID();
  await data.db.insert(data.skillDefinitions).values({
    id,
    sourceType: "registry_github",
    displayName: overrides.slug,
    description: "fixture",
    visibility: "public",
    status: "active",
    ownerUserId: "skill-fixture-owner",
    ...overrides,
  });
  return id;
}

/** A version row for `skillId` with fixture defaults; returns its id. */
export async function seedSkillVersion(
  data: Data,
  overrides: Partial<VersionInsert> & { skillId: string },
) {
  const id = overrides.id ?? randomUUID();
  await data.db.insert(data.skillVersions).values({
    id,
    version: "1.0.0",
    status: "published",
    isCurrent: true,
    manifestJson: {},
    ...overrides,
  } as VersionInsert);
  return id;
}
