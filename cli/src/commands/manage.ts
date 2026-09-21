import { RegistryError, type RegistryClient } from "../registry/client";
import { installFromRegistry } from "../install/install-skill";
import {
  findVersionSkew,
  removeInstalled,
  scanRoots,
  selectRoots,
  type InstalledSkill,
  type RootSelection,
} from "../install/inventory";
import { UsageError } from "../errors";
import type { fetchSkillFiles } from "../source/github";
import { confirm, table } from "../ui";

export type ManageContext = {
  json: boolean;
  out: (line: string) => void;
  /** The client for a registry a skill was installed from. */
  clientFor: (registry: string) => RegistryClient;
  download?: typeof fetchSkillFiles;
};

export type SkillFilter = RootSelection & { slug?: string };

async function findInstalled(filter: SkillFilter): Promise<InstalledSkill[]> {
  const { skills } = await scanRoots(selectRoots(filter));
  return filter.slug
    ? skills.filter((skill) => skill.metadata.slug === filter.slug)
    : skills;
}

function statusOf(skill: InstalledSkill): string {
  const { changes } = skill;
  if (changes.missing.length > 0) return "files missing";
  if (changes.modified.length > 0) return "modified";
  if (changes.added.length > 0) return "extra files";
  return "";
}

export async function listCommand(
  ctx: ManageContext,
  filter: SkillFilter,
): Promise<void> {
  const skills = await findInstalled(filter);
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        skills.map((s) => ({
          slug: s.metadata.slug,
          version: s.metadata.version,
          agent: s.agent,
          scope: s.scope,
          dir: s.dir,
          registry: s.metadata.registry,
          changes: s.changes,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (skills.length === 0) {
    ctx.out("No skills installed by sourceweft.");
    return;
  }
  ctx.out(
    table(
      skills.map((s) => [
        s.metadata.slug,
        s.metadata.version,
        `${s.agent}/${s.scope}`,
        statusOf(s),
        s.dir,
      ]),
    ),
  );
}

export async function removeCommand(
  ctx: ManageContext,
  filter: SkillFilter & { slug: string },
  options: { force: boolean; yes: boolean },
): Promise<void> {
  const skills = await findInstalled(filter);
  if (skills.length === 0) {
    throw new UsageError(
      `'${filter.slug}' is not installed by sourceweft here.`,
    );
  }
  for (const skill of skills) {
    ctx.out(`${skill.metadata.slug} → ${skill.dir}`);
  }
  if (
    !(await confirm(`Remove ${skills.length} install(s)?`, {
      assumeYes: options.yes,
    }))
  ) {
    ctx.out("Cancelled.");
    return;
  }
  for (const skill of skills) {
    await removeInstalled(skill, { force: options.force });
    ctx.out(`Removed ${skill.dir}`);
  }
}

type UpdateOutcome =
  | { skill: InstalledSkill; result: "up-to-date" }
  | { skill: InstalledSkill; result: "available"; commit: string }
  | { skill: InstalledSkill; result: "updated"; commit: string }
  | { skill: InstalledSkill; result: "gone" }
  | { skill: InstalledSkill; result: "renamed"; name: string };

export async function updateCommand(
  ctx: ManageContext,
  filter: SkillFilter,
  options: { dryRun: boolean; force: boolean; yes: boolean },
): Promise<void> {
  const installed = await findInstalled(filter);
  if (installed.length === 0) {
    ctx.out(
      filter.slug
        ? `'${filter.slug}' is not installed by sourceweft here.`
        : "No skills installed by sourceweft.",
    );
    return;
  }

  const outcomes: UpdateOutcome[] = [];
  let approved: boolean | undefined;
  for (const skill of installed) {
    let latest;
    try {
      latest = await ctx
        .clientFor(skill.metadata.registry)
        .getSkill(skill.metadata.slug);
    } catch (error) {
      if (error instanceof RegistryError && error.status === 404) {
        outcomes.push({ skill, result: "gone" });
        continue;
      }
      throw error;
    }
    const commit = latest.source.commitSha;
    if (!commit || commit === skill.metadata.source.commitSha) {
      outcomes.push({ skill, result: "up-to-date" });
      continue;
    }
    if (latest.skill.name !== skill.name) {
      outcomes.push({ skill, result: "renamed", name: latest.skill.name });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ skill, result: "available", commit });
      continue;
    }
    // An update brings new content, possibly new scripts: ask once for the run,
    // after saying what it would touch.
    ctx.out(
      `${skill.metadata.slug}: ${skill.metadata.source.commitSha.slice(0, 7)} → ${commit.slice(0, 7)}`,
    );
    approved ??= await confirm("Update the skills above?", {
      assumeYes: options.yes,
    });
    if (!approved) {
      outcomes.push({ skill, result: "available", commit });
      continue;
    }
    await installFromRegistry({
      skill: latest,
      registry: skill.metadata.registry,
      root: skill.root,
      force: options.force,
      ...(ctx.download ? { download: ctx.download } : {}),
    });
    outcomes.push({ skill, result: "updated", commit });
  }

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        outcomes.map((o) => ({
          slug: o.skill.metadata.slug,
          dir: o.skill.dir,
          result: o.result,
          ...("commit" in o ? { commit: o.commit } : {}),
        })),
        null,
        2,
      ),
    );
    return;
  }
  for (const o of outcomes) {
    const label = o.skill.metadata.slug;
    switch (o.result) {
      case "up-to-date":
        ctx.out(`${label}: up to date`);
        break;
      case "available":
        ctx.out(`${label}: update available (${o.commit.slice(0, 7)})`);
        break;
      case "updated":
        ctx.out(`${label}: updated to ${o.commit.slice(0, 7)}`);
        break;
      case "gone":
        ctx.out(`${label}: no longer in the registry (left installed)`);
        break;
      case "renamed":
        ctx.out(
          `${label}: now named '${o.name}'; remove and reinstall it to update`,
        );
        break;
    }
  }
}

export type DoctorFinding = { level: "problem" | "note"; message: string };

export async function doctorCommand(
  ctx: ManageContext,
  filter: RootSelection,
): Promise<number> {
  const inventory = await scanRoots(selectRoots(filter));
  const findings: DoctorFinding[] = [];
  for (const issue of inventory.issues) {
    findings.push({
      level: "problem",
      message:
        issue.kind === "corrupt-metadata"
          ? `${issue.dir}: .sourceweft.json is unreadable`
          : `${issue.dir}: left behind by an interrupted install; safe to delete`,
    });
  }
  for (const skill of inventory.skills) {
    const { changes } = skill;
    for (const path of changes.missing) {
      findings.push({
        level: "problem",
        message: `${skill.dir}: '${path}' is missing`,
      });
    }
    for (const path of changes.modified) {
      findings.push({
        level: "note",
        message: `${skill.dir}: '${path}' was edited`,
      });
    }
    if (changes.added.length > 0) {
      findings.push({
        level: "note",
        message: `${skill.dir}: ${changes.added.length} extra file(s) added`,
      });
    }
  }
  for (const [slug, group] of findVersionSkew(inventory.skills)) {
    findings.push({
      level: "problem",
      message: `${slug} is installed at different versions: ${group
        .map((s) => `${s.agent}/${s.scope}=${s.metadata.version}`)
        .join(", ")}`,
    });
  }

  const problems = findings.filter((f) => f.level === "problem").length;
  if (ctx.json) {
    ctx.out(
      JSON.stringify({ skills: inventory.skills.length, findings }, null, 2),
    );
  } else if (findings.length === 0) {
    ctx.out(
      `OK — ${inventory.skills.length} installed skill(s), no problems found.`,
    );
  } else {
    for (const f of findings) {
      ctx.out(`${f.level === "problem" ? "problem" : "note   "}  ${f.message}`);
    }
  }
  return problems > 0 ? 1 : 0;
}
