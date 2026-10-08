import assert from "node:assert/strict";
import { beforeAll, afterAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let data: typeof import("@sourceweft/db");
let references: typeof import("./install-references");
const original = process.env.DATABASE_URL;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("install_refs");
  process.env.DATABASE_URL = isolated.url;
  data = await import("@sourceweft/db");
  references = await import("./install-references");
}, 120000);
afterAll(async () => {
  await data?.closeDatabase();
  await isolated?.close();
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});
async function seed(
  id: string,
  owner: string,
  repo: string,
  root: string,
  visibility = "public",
) {
  const slug = `gh-${owner}-${repo}-deploy-${id}`;
  await data.database.query(
    `insert into skill_definitions(id,source_type,slug,display_name,description,visibility,repo_owner,repo_name,source_root) values($1,'registry_github',$2,'Deploy','Deploy a project',$3,$4,$5,$6)`,
    [id, slug, visibility, owner, repo, root],
  );
  const manifest = {
    slug,
    displayName: "Deploy",
    description: "Deploy a project",
    version: "1",
    visibility,
    categories: [],
    registry: {
      repoUrl: `https://github.com/${owner}/${repo}`,
      sourceUrl: `https://github.com/${owner}/${repo}/tree/${"a".repeat(40)}/${root}`,
      identifier: `gh:${owner}/${repo}/${root}`,
      submittedBy: "fixture",
      capability: "prompt-only",
      scan: { reviewRequired: false, flags: [] },
      fileManifest: [],
    },
  };
  await data.database.query(
    `insert into skill_versions(id,skill_id,version,status,storage_type,storage_pointer,is_current,content_hash,skill_md,manifest_json) values($1,$2,'1','published','db_text',$3,true,'fixture',$4,$5)`,
    [
      `${id}-v`,
      id,
      `github:${owner}/${repo}@${"a".repeat(40)}#${root}`,
      "---\nname: deploy\ndescription: Deploy a project\n---\nDeploy safely.",
      JSON.stringify(manifest),
    ],
  );
  return slug;
}
test("recorded aliases survive new collisions and upstream name changes", async () => {
  const first = await seed("first", "acme", "tools", "skills/deploy");
  await references.reconcileSkillInstallReferences("acme");
  const detail = await (
    await import("../market/read-repository")
  ).findMarketSkill(first);
  assert.equal(detail?.skill.installRef, "@acme/deploy");
  assert.equal(detail?.skill.name, "deploy");
  assert.equal(
    (
      await references.resolveSkillInstallReferences({
        reference: "@acme/deploy",
      })
    ).items[0]?.slug,
    first,
  );
  await seed("second", "acme", "other-tools", "skills/deploy");
  await Promise.all([
    references.reconcileSkillInstallReferences("acme"),
    references.reconcileSkillInstallReferences("acme"),
  ]);
  assert.equal(
    (
      await references.resolveSkillInstallReferences({
        reference: "@acme/deploy",
      })
    ).items[0]?.slug,
    first,
  );
  await data.database.query(
    `update skill_versions set skill_md=replace(skill_md,'name: deploy','name: renamed'),manifest_json=jsonb_set(manifest_json,'{registry,originalName}','"renamed"'::jsonb) where skill_id='first'`,
  );
  await references.reconcileSkillInstallReferences("acme");
  const resolved = await references.resolveSkillInstallReferences({
    reference: "@acme/deploy",
  });
  assert.equal(resolved.items[0]?.name, "renamed");
  assert.equal(resolved.items[0]?.slug, first);
});
test("initial same-name paths are explicit choices and exact paths disambiguate", async () => {
  await seed("fig-a", "figma", "guide", "skills/deploy");
  const second = await seed(
    "fig-b",
    "figma",
    "guide",
    "skills-figquery/deploy",
  );
  await references.reconcileSkillInstallReferences("figma");
  const choices = await references.resolveSkillInstallReferences({
    reference: "@figma/deploy",
  });
  assert.equal(choices.items.length, 2);
  assert.ok(choices.items.every((item) => item.installRef !== "@figma/deploy"));
  const exact = await references.resolveSkillInstallReferences({
    reference: "figma/guide",
    skill: "deploy",
    path: "skills-figquery/deploy",
  });
  assert.equal(exact.items.length, 1);
  assert.equal(exact.items[0]?.slug, second);
  assert.equal(
    (await references.reconcileSkillInstallReferences("figma")).created,
    0,
  );
});
test("unpublished/private records remain invisible to all reference forms", async () => {
  await seed("hidden", "private-owner", "tools", "skills/deploy", "restricted");
  await references.reconcileSkillInstallReferences("private-owner");
  await seed("public-other", "private-owner", "other", "skills/deploy");
  await references.reconcileSkillInstallReferences("private-owner");
  assert.deepEqual(
    await references.resolveSkillInstallReferences({
      reference: "@private-owner/deploy",
    }),
    { items: [], exact: true },
  );
  assert.deepEqual(
    await references.resolveSkillInstallReferences({
      reference: "private-owner/tools",
      skill: "deploy",
      path: "skills/deploy",
    }),
    { items: [], exact: true },
  );
});

test("old inline-file versions retain their original name and stable page slug", async () => {
  const slug = await seed("inline", "old-owner", "tools", "skills/deploy");
  await data.database.query(
    `insert into skill_version_files(id,skill_version_id,path,mime_type,size_bytes,content_hash,content_text) select 'inline-file',id,'SKILL.md','text/markdown',octet_length(skill_md),repeat('a',64),skill_md from skill_versions where id='inline-v'`,
  );
  await data.database.query(
    `update skill_versions set skill_md=null where id='inline-v'`,
  );
  await references.reconcileSkillInstallReferences("old-owner");
  const resolved = await references.resolveSkillInstallReferences({
    reference: "@old-owner/deploy",
  });
  assert.equal(resolved.items[0]?.slug, slug);
  assert.equal(resolved.items[0]?.name, "deploy");
});

test("the retained historical page keeps its short reference when old paths split", async () => {
  const primary = await seed(
    "aws-current",
    "aws",
    "toolkit",
    "skills/core/deploy",
  );
  await seed("aws-history", "aws", "toolkit", "skills/deploy");
  await data.database.query(
    `insert into skill_market_events(id,skill_id,actor_kind,action,detail) values('aws-migration','aws-current','system','source.identity.migrated','{"preservedId":true}')`,
  );
  await references.reconcileSkillInstallReferences("aws");
  const resolved = await references.resolveSkillInstallReferences({
    reference: "@aws/deploy",
  });
  assert.equal(resolved.exact, true);
  assert.equal(resolved.items[0]?.slug, primary);
  const other = await references.resolveSkillInstallReferences({
    reference: "aws/toolkit",
    skill: "deploy",
    path: "skills/deploy",
  });
  assert.notEqual(other.items[0]?.installRef, "@aws/deploy");
});

test("generated variant labels cannot take another skill's natural name", async () => {
  await seed("a-variant", "collision", "tools", "extra/deploy");
  await seed("b-variant", "collision", "tools", "skills/deploy");
  const literal = await seed(
    "z-literal",
    "collision",
    "tools",
    "skills/deploy-extra",
  );
  await data.database.query(
    `update skill_versions set skill_md=replace(skill_md,'name: deploy','name: deploy-extra') where id='z-literal-v'`,
  );
  await references.reconcileSkillInstallReferences("collision");
  const resolved = await references.resolveSkillInstallReferences({
    reference: "@collision/deploy-extra",
  });
  assert.equal(resolved.exact, true);
  assert.equal(resolved.items[0]?.slug, literal);
});
