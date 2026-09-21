import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isSafeSkillDirName } from "@sourceweft/skill-format";
import {
  AGENTS,
  pathKey,
  resolveSkillsRoot,
  type AgentProfile,
  type InstallScope,
} from "./agents";
import {
  detectLocalChanges,
  hasLocalChanges,
  readMetadataState,
  type InstalledMetadata,
  type LocalChanges,
} from "./metadata";
import { InstallConflictError, REMOVE_TREE_OPTIONS } from "./write";

/**
 * What this CLI has installed, found by looking at the skills directories of
 * the agents rather than at any list of its own: a skill is ours exactly when
 * its directory carries a valid `.sourceweft.json`. Removing a skill by hand
 * therefore cannot leave the inventory out of step.
 */

export type SkillsRoot = {
  agent: string;
  scope: InstallScope;
  root: string;
};

export type InstalledSkill = SkillsRoot & {
  /** The skill's directory: `<root>/<name>`. */
  dir: string;
  name: string;
  metadata: InstalledMetadata;
  changes: LocalChanges;
};

export type InventoryIssue =
  | { kind: "corrupt-metadata"; dir: string }
  | { kind: "stale-staging"; dir: string };

export type Inventory = { skills: InstalledSkill[]; issues: InventoryIssue[] };

export type RootSelection = {
  agents?: readonly AgentProfile[];
  scope?: InstallScope | "all";
  /** Scan this one directory instead of the agents' own. */
  dir?: string;
  home?: string;
  cwd?: string;
};

/** The directories to look in. Roots that resolve to the same path count once. */
export function selectRoots(selection: RootSelection = {}): SkillsRoot[] {
  const cwd = selection.cwd ?? process.cwd();
  if (selection.dir) {
    return [
      {
        agent: "custom",
        scope: "user",
        root: resolveSkillsRoot({
          agent: AGENTS[0]!,
          scope: "user",
          dir: selection.dir,
          cwd,
        }),
      },
    ];
  }
  const scopes: InstallScope[] =
    !selection.scope || selection.scope === "all"
      ? ["user", "project"]
      : [selection.scope];
  const seen = new Set<string>();
  const roots: SkillsRoot[] = [];
  for (const agent of selection.agents ?? AGENTS) {
    for (const scope of scopes) {
      const root = resolve(
        resolveSkillsRoot({
          agent,
          scope,
          cwd,
          ...(selection.home ? { home: selection.home } : {}),
        }),
      );
      const key = pathKey(root);
      if (!seen.has(key)) {
        seen.add(key);
        roots.push({ agent: agent.id, scope, root });
      }
    }
  }
  return roots;
}

const STAGING = /^\.sourceweft-tmp-/u;

export async function scanRoots(
  roots: readonly SkillsRoot[],
): Promise<Inventory> {
  const inventory: Inventory = { skills: [], issues: [] };
  for (const location of roots) {
    let entries;
    try {
      entries = await readdir(location.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(location.root, entry.name);
      if (STAGING.test(entry.name)) {
        inventory.issues.push({ kind: "stale-staging", dir });
        continue;
      }
      // A link at a skill's place is somebody else's arrangement, not our install.
      if (!entry.isDirectory()) {
        continue;
      }
      const state = await readMetadataState(dir);
      if (state.state === "absent") {
        continue;
      }
      if (state.state === "corrupt") {
        inventory.issues.push({ kind: "corrupt-metadata", dir });
        continue;
      }
      inventory.skills.push({
        ...location,
        dir,
        name: entry.name,
        metadata: state.metadata,
        changes: await detectLocalChanges(dir, state.metadata),
      });
    }
  }
  return inventory;
}

/**
 * Deletes an installed skill's directory. Everything is re-checked at the
 * moment of deletion rather than trusted from the earlier scan: the path must
 * still be a real directory (not a link put there since), still be this skill's
 * install, and be under the root it was found in. Edited, missing or added
 * files block it unless `force`, since they are lost with the directory.
 */
export async function removeInstalled(
  skill: InstalledSkill,
  options: { force?: boolean } = {},
): Promise<void> {
  if (
    !isSafeSkillDirName(skill.name) ||
    basename(skill.dir) !== skill.name ||
    pathKey(resolve(dirname(skill.dir))) !== pathKey(resolve(skill.root))
  ) {
    throw new Error(`Refusing to remove ${skill.dir}`);
  }
  const stat = await lstat(skill.dir);
  if (!stat.isDirectory()) {
    throw new Error(`${skill.dir} is not a directory`);
  }
  const state = await readMetadataState(skill.dir);
  if (state.state !== "ok" || state.metadata.slug !== skill.metadata.slug) {
    throw new InstallConflictError(
      "NOT_OURS",
      skill.dir,
      `${skill.dir} is no longer an install of '${skill.metadata.slug}'.`,
    );
  }
  if (
    !options.force &&
    hasLocalChanges(await detectLocalChanges(skill.dir, state.metadata))
  ) {
    throw new InstallConflictError(
      "LOCALLY_MODIFIED",
      skill.dir,
      `${skill.dir} has local changes that removing it would delete. Re-run with --force to remove it anyway.`,
    );
  }
  // Not `force`: a directory that is already gone should still be an error here.
  await rm(skill.dir, {
    recursive: true,
    maxRetries: REMOVE_TREE_OPTIONS.maxRetries,
    retryDelay: REMOVE_TREE_OPTIONS.retryDelay,
  });
}

/** Installs of the same slug that sit at different commits. */
export function findVersionSkew(
  skills: readonly InstalledSkill[],
): Map<string, InstalledSkill[]> {
  const bySlug = new Map<string, InstalledSkill[]>();
  for (const skill of skills) {
    bySlug.set(skill.metadata.slug, [
      ...(bySlug.get(skill.metadata.slug) ?? []),
      skill,
    ]);
  }
  for (const [slug, group] of bySlug) {
    if (new Set(group.map((s) => s.metadata.source.commitSha)).size < 2) {
      bySlug.delete(slug);
    }
  }
  return bySlug;
}
