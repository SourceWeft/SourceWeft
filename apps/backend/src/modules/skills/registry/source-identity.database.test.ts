import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import { deriveRegistrySlug } from "./contracts";

const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  sandboxAssetObjectExists: async ({ key }: { key: string }) =>
    store.objects.has(key),
  uploadFileObject: async ({ key, body }: { key: string; body: Buffer }) => {
    store.objects.set(key, body);
    return { bucket: "bucket", key };
  },
  downloadFileObject: async ({ key }: { key: string }) =>
    store.objects.get(key)!,
}));
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let data: typeof import("@sourceweft/db");
let repo: typeof import("./repository");
const originalUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("source_identity");
  process.env.DATABASE_URL = isolated.url;
  data = await import("@sourceweft/db");
  repo = await import("./repository");
}, 120_000);
afterAll(async () => {
  await data?.closeDatabase();
  await isolated?.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});
function input(
  root: string,
  commit = "a".repeat(40),
  owner = "figma",
  repositoryId = "100",
) {
  const slug = deriveRegistrySlug(
    owner,
    "guide",
    "figma-use",
    root,
    repositoryId,
  );
  return {
    slug,
    submitterId: "owner",
    displayName: "figma-use",
    description: "fixture",
    commitSha: commit,
    storagePointer: `github:${owner}/guide@${commit}#${root}`,
    versionStatus: "published" as const,
    outcome: "indexed" as const,
    files: [
      {
        path: "SKILL.md",
        bytes: Buffer.from(
          `---\nname: figma-use\ndescription: fixture\n---\n${root} ${commit}`,
        ),
        mimeType: "text/markdown",
      },
    ],
    manifestJson: {
      slug,
      displayName: "figma-use",
      description: "fixture",
      version: commit,
      visibility: "restricted" as const,
      categories: [],
      registry: {
        identifier: `gh:${owner}/guide/${root}`,
        repositoryId,
        sourceRoot: root,
        sourceUrl: `https://github.com/${owner}/guide/tree/${commit}/${root}`,
        repoUrl: `https://github.com/${owner}/guide`,
        submittedBy: "owner",
        committedAt: "2026-10-01T00:00:00Z",
        capability: "prompt-only" as const,
        scan: { reviewRequired: false, flags: [] },
        fileManifest: [],
      },
    },
  };
}
test("same-name roots coexist, concurrent repeated sources are idempotent, rename preserves URL", async () => {
  const a = input("skills/figma-use"),
    b = input("skills#figquery/figma-use");
  const [first, second] = await Promise.all([
    repo.upsertRegistrySkillIndex(a),
    repo.upsertRegistrySkillIndex(b),
  ]);
  assert.notEqual(first.skillId, second.skillId);
  assert.notEqual(first.slug, second.slug);
  const replacementRepo = await repo.upsertRegistrySkillIndex(
    input("skills/figma-use", "a".repeat(40), "figma", "200"),
  );
  assert.notEqual(replacementRepo.skillId, first.skillId);
  const repeats = await Promise.all([
    repo.upsertRegistrySkillIndex(a),
    repo.upsertRegistrySkillIndex(a),
  ]);
  for (const result of repeats)
    assert.equal(result.skillVersionId, first.skillVersionId);
  assert.equal(
    await repo.getRegistrySlugForSource({
      owner: "renamed",
      repo: "guide",
      repositoryId: "100",
      sourceRoot: a.manifestJson.registry.sourceRoot,
      proposedSlug: "new-slug",
    }),
    first.slug,
  );
  await data.database.query(
    `update skill_versions set version=$1 where id=$2`,
    [a.commitSha.slice(0, 12), first.skillVersionId],
  );
  const legacyRepeat = await repo.upsertRegistrySkillIndex(a);
  assert.equal(legacyRepeat.skillVersionId, first.skillVersionId);
  assert.equal(legacyRepeat.version, a.commitSha.slice(0, 12));
  const renameRetry = await repo.upsertRegistrySkillIndex(
    input("skills/figma-use", a.commitSha, "renamed"),
  );
  assert.equal(renameRetry.skillVersionId, first.skillVersionId);
  assert.equal(renameRetry.slug, first.slug);
  const renamed = await repo.upsertRegistrySkillIndex(
    input("skills/figma-use", "b".repeat(40), "renamed"),
  );
  assert.equal(renamed.skillId, first.skillId);
  assert.equal(renamed.slug, first.slug);
  const longCommit = "b".repeat(12) + "c".repeat(28);
  const another = await repo.upsertRegistrySkillIndex(
    input("skills/figma-use", longCommit, "renamed"),
  );
  assert.notEqual(another.skillVersionId, renamed.skillVersionId);
});
test("historical split preserves old URL, exact version IDs, disabled configuration and grants", async () => {
  await data.database.query(
    `insert into skill_definitions(id,source_type,slug,display_name,description,visibility,repo_owner,repo_name) values('legacy','registry_github','legacy-url','figma-use','fixture','restricted','legacy','guide')`,
  );
  const manifest = (root: string) =>
    JSON.stringify({ ...input(root).manifestJson, slug: "legacy-url" });
  for (const [id, root, sha, current] of [
    ["legacy-a", "skills/figma-use", "c", true],
    ["legacy-b", "skills#figquery/figma-use", "d", false],
  ] as const) {
    await data.database.query(
      `insert into skill_versions(id,skill_id,version,status,storage_type,storage_pointer,is_current,content_hash,manifest_json) values($1,'legacy',$2,'published','db_text',$3,$4,'fixture',$5)`,
      [
        id,
        sha.repeat(12),
        `github:legacy/guide@${sha.repeat(40)}#${root}`,
        current,
        manifest(root),
      ],
    );
  }
  await data.database.query(
    `insert into workspaces(id,organization_id,name,slug) values('identity-ws','identity-team','fixture','identity-ws')`,
  );
  await data.database.query(
    `insert into workspace_skills(id,team_id,workspace_id,skill_id,skill_version_id,enabled,config_json) values('installed','identity-team','identity-ws','legacy','legacy-b',false,'{"keep":"configuration"}')`,
  );
  await data.database.query(
    `insert into skill_entitlements(id,skill_id,team_id,workspace_id,granted_by) values('grant','legacy','identity-team','identity-ws','owner')`,
  );
  const migration = await readFile(
    new URL(
      "../../../../../../packages/db/drizzle/0060_skill_source_identity.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const replay = async () => {
    const client = await data.database.connect();
    try {
      await client.query("BEGIN");
      for (const statement of migration
        .split("--> statement-breakpoint")
        .slice(2, -2))
        if (statement.trim()) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await replay();
  const versions = (
    await data.database.query(
      `select id,skill_id from skill_versions where id in ('legacy-a','legacy-b') order by id`,
    )
  ).rows;
  assert.equal(versions[0].skill_id, "legacy");
  assert.notEqual(versions[1].skill_id, "legacy");
  const installed = (
    await data.database.query(
      `select * from workspace_skills where id='installed'`,
    )
  ).rows[0];
  assert.equal(installed.skill_version_id, "legacy-b");
  assert.equal(installed.skill_id, versions[1].skill_id);
  assert.equal(installed.enabled, false);
  assert.deepEqual(installed.config_json, { keep: "configuration" });
  const legacy = (
    await data.database.query(
      `select slug,source_root from skill_definitions where id='legacy'`,
    )
  ).rows[0];
  assert.deepEqual(legacy, {
    slug: "legacy-url",
    source_root: "skills/figma-use",
  });
  assert.equal(
    (
      await data.database.query(
        `select count(*)::int n from skill_entitlements where skill_id=$1`,
        [versions[1].skill_id],
      )
    ).rows[0].n,
    1,
  );
  await replay();
  assert.equal(
    (
      await data.database.query(
        `select skill_id from skill_versions where id='legacy-b'`,
      )
    ).rows[0].skill_id,
    versions[1].skill_id,
  );
});
