import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  type SkillManifestJson,
} from "@sourceweft/db";
import {
  marketSkillName,
  publicMarketSkillCondition,
} from "../market/read-repository";

type SourceRow = {
  id: string;
  slug: string;
  installRef: string | null;
  owner: string;
  repo: string;
  root: string;
  manifest: SkillManifestJson;
  skillMd: string | null;
  versionId?: string;
  legacyPrimary?: boolean;
};
const segment = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Aliases are allocated once. A later collision never retargets an existing alias. */
export function planSkillInstallReferences(
  rows: readonly SourceRow[],
  reserved: ReadonlySet<string>,
) {
  const names = new Map(
    rows.map((row) => [
      row.id,
      marketSkillName({
        slug: row.slug,
        manifest: row.manifest,
        skillMd: row.skillMd,
      }),
    ]),
  );
  const groups = new Map<string, SourceRow[]>();
  const groupKey = (row: SourceRow) =>
    `${row.owner.toLowerCase()}\0${segment(names.get(row.id)!)}`;
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const taken = new Set(reserved);
  const planned: Array<{ id: string; installRef: string }> = [];
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    if (row.installRef) continue;
    const name = names.get(row.id)!;
    const peers = groups.get(groupKey(row))!;
    const base = `@${row.owner.toLowerCase()}/${segment(name)}`;
    if (!segment(name))
      throw new Error(`Skill ${row.id} has no usable original name`);
    let reference = base;
    const prior = peers.filter((peer) => peer.legacyPrimary);
    const legacyCanonical =
      new Set(peers.map((peer) => peer.repo.toLowerCase())).size === 1 &&
      prior.length === 1
        ? prior[0]
        : undefined;
    if (
      (peers.length > 1 && legacyCanonical?.id !== row.id) ||
      taken.has(reference)
    ) {
      const differentRepos =
        new Set(peers.map((other) => other.repo.toLowerCase())).size > 1;
      const hintFor = (source: SourceRow) => {
        const parents = source.root.split("/").slice(0, -1).filter(Boolean);
        if (
          parents.length > 1 &&
          ["skills", ".agents", ".claude"].includes(parents[0]!)
        )
          parents.shift();
        return (
          segment(
            differentRepos
              ? source.repo
              : (parents.join("-") || "root").replace(/^skills-/, ""),
          ).slice(0, 64) || "root"
        );
      };
      const hint = hintFor(row);
      reference = `${base}-${hint}`;
      if (
        taken.has(reference) ||
        peers.some((other) => other.id !== row.id && hintFor(other) === hint)
      ) {
        reference += `-${createHash("sha256").update(`${row.repo}\0${row.root}`).digest("hex").slice(0, 12)}`;
      }
    }
    if (taken.has(reference))
      throw new Error("Skill install reference collision");
    taken.add(reference);
    planned.push({ id: row.id, installRef: reference });
  }
  return planned;
}

/** Called after a complete import and during upkeep to reconcile pre-existing records. */
export async function reconcileSkillInstallReferences(owner?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('skill-install-references'))`,
    );
    const missing = await tx.execute(
      sql`select 1 from skill_definitions where source_type='registry_github' and install_ref is null and repo_owner is not null and source_root is not null ${owner ? sql`and repo_owner=${owner.toLowerCase()}` : sql``} limit 1`,
    );
    if (!missing.rows.length) return { created: 0 };
    const result = await tx.execute<SourceRow>(sql`
   select distinct on(d.id) d.id,d.slug,d.install_ref as "installRef",d.repo_owner as owner,d.repo_name as repo,d.source_root as root,exists(select 1 from skill_market_events e where e.skill_id=d.id and e.action='source.identity.migrated' and e.detail->>'preservedId'='true') as "legacyPrimary",v.id as "versionId",v.manifest_json as manifest,coalesce(v.skill_md,(select content_text from skill_version_files where skill_version_id=v.id and path='SKILL.md')) as "skillMd"
   from skill_definitions d join skill_versions v on v.skill_id=d.id
   where d.source_type='registry_github' and d.repo_owner is not null and d.source_root is not null
    ${owner ? sql`and d.repo_owner=${owner.toLowerCase()}` : sql`and d.repo_owner in (select repo_owner from skill_definitions where source_type='registry_github' and install_ref is null and source_root is not null)`}
   order by d.id,v.is_current desc,v.created_at desc,v.id desc`);
    const held = await tx
      .select({ ref: skillDefinitions.installRef })
      .from(skillDefinitions);
    const plan = planSkillInstallReferences(
      result.rows,
      new Set(held.flatMap((row) => (row.ref ? [row.ref] : []))),
    );
    for (const item of plan)
      await tx
        .update(skillDefinitions)
        .set({ installRef: item.installRef })
        .where(eq(skillDefinitions.id, item.id));
    for (const row of result.rows) {
      if (row.versionId && !row.manifest.registry?.originalName) {
        const originalName = marketSkillName({
          slug: row.slug,
          manifest: row.manifest,
          skillMd: row.skillMd,
        });
        await tx.execute(
          sql`update skill_versions set manifest_json=jsonb_set(manifest_json,'{registry,originalName}',to_jsonb(${originalName}::text)) where id=${row.versionId}`,
        );
      }
    }
    return { created: plan.length };
  });
}

export async function resolveSkillInstallReferences(input: {
  reference: string;
  skill?: string;
  path?: string;
}) {
  const scoped = /^@([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(
    input.reference,
  );
  const repository = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(
    input.reference,
  );
  if (!scoped && (!repository || !input.skill))
    throw new Error("Use @owner/skill or owner/repo with --skill");
  const owner = (scoped?.[1] ?? repository![1]!).toLowerCase();
  const reference = scoped ? `@${owner}/${scoped[2]}` : input.reference;
  const conditions = [
    publicMarketSkillCondition(),
    eq(skillDefinitions.sourceType, "registry_github"),
    sql`${skillDefinitions.installRef} is not null`,
  ];
  if (input.path !== undefined)
    conditions.push(eq(skillDefinitions.sourceRoot, input.path));
  const requestedName = scoped?.[2] ?? input.skill!;
  const nameCondition = sql`(coalesce(${skillVersions.manifestJson}->'registry'->>'originalName',${skillVersions.manifestJson}->>'name')=${requestedName} or coalesce(${skillVersions.manifestJson}->'registry'->>'originalName',${skillVersions.manifestJson}->>'name') is null)`;
  const rows = await db
    .select({
      definition: skillDefinitions,
      version: {
        manifestJson: skillVersions.manifestJson,
        skillMd: sql<
          string | null
        >`coalesce(${skillVersions.skillMd},(select content_text from skill_version_files where skill_version_id=${skillVersions.id} and path='SKILL.md'))`,
      },
    })
    .from(skillDefinitions)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skillDefinitions.id))
    .where(
      and(
        ...conditions,
        scoped
          ? sql`(${skillDefinitions.installRef}=${reference} or (${skillDefinitions.repoOwner}=${owner} and ${nameCondition}))`
          : and(
              eq(skillDefinitions.repoOwner, owner),
              eq(skillDefinitions.repoName, repository![2]!.toLowerCase()),
              nameCondition,
            ),
      ),
    );
  const heldAlias = scoped
    ? await db
        .select({ id: skillDefinitions.id })
        .from(skillDefinitions)
        .where(eq(skillDefinitions.installRef, reference))
        .limit(1)
    : [];
  const exact = scoped
    ? rows.filter((row) => row.definition.installRef === reference)
    : [];
  const matching = heldAlias.length
    ? exact
    : rows.filter(
        (row) =>
          marketSkillName({
            slug: row.definition.slug,
            manifest: row.version.manifestJson,
            skillMd: row.version.skillMd,
          }) === (scoped?.[2] ?? input.skill),
      );
  return {
    exact: matching.length === 0 || !scoped || heldAlias.length > 0,
    items: matching
      .map(({ definition: d, version: v }) => ({
        slug: d.slug,
        installRef: d.installRef,
        name: marketSkillName({
          slug: d.slug,
          manifest: v.manifestJson,
          skillMd: v.skillMd,
        }),
        repoUrl: v.manifestJson.registry?.repoUrl ?? null,
        repoSubpath: d.sourceRoot,
        description: v.manifestJson.description,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}
