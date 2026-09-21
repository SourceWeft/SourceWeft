import { RegistryError, type RegistryClient } from "../registry/client";
import type { SkillResponse } from "../registry/schema";
import {
  AGENTS,
  findAgent,
  resolveTargets,
  type InstallScope,
} from "../install/agents";
import { installFromRegistry, resolveSource } from "../install/install-skill";
import { UnsupportedRegistryError, UsageError } from "../errors";
import type { fetchSkillFiles } from "../source/github";
import { confirm, table, truncate } from "../ui";

export type CommandContext = {
  client: RegistryClient;
  registry: string;
  json: boolean;
  out: (line: string) => void;
  /** Replaceable in tests; production downloads from GitHub. */
  download?: typeof fetchSkillFiles;
};

const SORTS = ["recommended", "popular", "new", "name"];

export async function searchCommand(
  ctx: CommandContext,
  input: { query: string; category?: string; sort?: string; limit?: number },
): Promise<void> {
  if (input.sort && !(SORTS as readonly string[]).includes(input.sort)) {
    throw new UsageError(`--sort must be one of: ${SORTS.join(", ")}`);
  }
  const page = await ctx.client
    .listSkills({
      ...(input.query ? { query: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.sort ? { sort: input.sort } : {}),
      limit: input.limit ?? 20,
    })
    .catch((error: unknown) => {
      // A search has no "no such skill" answer, so a 404 means the registry
      // does not serve the marketplace API at all.
      if (error instanceof RegistryError && error.status === 404) {
        throw new UnsupportedRegistryError(ctx.registry);
      }
      throw error;
    });
  if (ctx.json) {
    ctx.out(JSON.stringify(page, null, 2));
    return;
  }
  if (page.items.length === 0) {
    ctx.out("No skills found.");
    return;
  }
  ctx.out(
    table(
      page.items.map((item) => [
        item.slug,
        item.verified ? "verified" : "",
        item.capability === "executable" ? "scripts" : "",
        truncate(item.description, 70),
      ]),
    ),
  );
}

/** What a person should know before running this skill's contents. */
export function describeSkill(skill: SkillResponse): string[] {
  const { skill: listing, source } = skill;
  const lines = [
    `${listing.slug}  (${listing.displayName})`,
    truncate(listing.description, 200),
    "",
    `Version:    ${listing.version}`,
    `License:    ${listing.license ?? "not stated"}`,
    `Source:     ${source.sourceUrl ?? source.repoUrl ?? "unknown"}`,
    `Verified:   ${listing.verified ? "yes, by a SourceWeft admin" : "no"}`,
    `Files:      ${skill.files.length}`,
  ];
  if (listing.capability === "executable") {
    lines.push("Scripts:    yes — this skill includes executable files");
  }
  if (skill.scanFlags.length > 0) {
    lines.push(`Scan flags: ${skill.scanFlags.join(", ")}`);
  }
  return lines;
}

export async function infoCommand(
  ctx: CommandContext,
  input: { slug: string },
): Promise<void> {
  const skill = await ctx.client.getSkill(input.slug);
  if (ctx.json) {
    ctx.out(JSON.stringify(skill, null, 2));
    return;
  }
  for (const line of describeSkill(skill)) {
    ctx.out(line);
  }
}

export type InstallCommandInput = {
  slug: string;
  agents: string[];
  scope: InstallScope;
  dir?: string;
  force: boolean;
  yes: boolean;
};

export async function installCommand(
  ctx: CommandContext,
  input: InstallCommandInput,
): Promise<void> {
  const profiles = input.agents.map((id) => {
    const agent = findAgent(id);
    if (!agent) {
      throw new UsageError(
        `Unknown agent '${id}'. Known agents: ${AGENTS.map((a) => a.id).join(", ")}`,
      );
    }
    return agent;
  });
  if (input.dir && profiles.length > 1) {
    throw new UsageError(
      "--dir installs into one place; use it with a single --agent",
    );
  }

  const skill = await ctx.client.getSkill(input.slug);
  // Fail on an unsupported source before asking anyone to confirm anything.
  resolveSource(skill);

  if (!ctx.json) {
    for (const line of describeSkill(skill)) {
      ctx.out(line);
    }
    ctx.out("");
  }
  const proceed = await confirm(
    skill.skill.capability === "executable"
      ? "This skill includes scripts your agent may run. Install it?"
      : "Install this skill?",
    { assumeYes: input.yes },
  );
  if (!proceed) {
    ctx.out("Cancelled.");
    return;
  }

  const results = [];
  // Agents that share a directory are installed for once, not once each.
  for (const target of resolveTargets({
    agents: profiles,
    scope: input.scope,
    ...(input.dir ? { dir: input.dir } : {}),
  })) {
    const result = await installFromRegistry({
      skill,
      registry: ctx.registry,
      root: target.root,
      force: input.force,
      ...(ctx.download ? { download: ctx.download } : {}),
    });
    const agents = target.agents.map((agent) => agent.id);
    results.push({
      agents,
      dir: result.dir,
      replaced: result.replaced,
      unchanged: result.unchanged,
    });
    if (!ctx.json) {
      const verb = result.unchanged
        ? "Already up to date:"
        : result.replaced
          ? "Updated"
          : "Installed";
      ctx.out(
        `${verb} ${skill.skill.slug} → ${result.dir} (${agents.join(", ")})`,
      );
    }
  }
  if (ctx.json) {
    ctx.out(
      JSON.stringify({ slug: skill.skill.slug, installed: results }, null, 2),
    );
  }
}
