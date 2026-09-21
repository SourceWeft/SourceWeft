import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isSafeBundlePath, isSafeSkillDirName } from "@sourceweft/skill-format";
import {
  detectLocalChanges,
  hasLocalChanges,
  METADATA_FILE,
  readMetadata,
  serializeMetadata,
  type InstalledMetadata,
} from "./metadata";
import type { VerifiedFile } from "./verify";

export type InstallConflictCode =
  /** Something is at the target that this CLI did not put there. */
  | "NOT_OURS"
  /** A skill of ours is there, but from a different slug or registry. */
  | "OTHER_SOURCE"
  /** The installed files were edited or removed since install. */
  | "LOCALLY_MODIFIED";

export class InstallConflictError extends Error {
  readonly code: InstallConflictCode;
  readonly path: string;

  constructor(code: InstallConflictCode, path: string, message: string) {
    super(message);
    this.name = "InstallConflictError";
    this.code = code;
    this.path = path;
  }
}

export type WriteSkillInput = {
  /** The agent's skills directory, e.g. `~/.claude/skills`. */
  root: string;
  /** The skill's directory name under `root`. */
  name: string;
  files: readonly VerifiedFile[];
  metadata: InstalledMetadata;
  /** Replace a skill of ours even though its files were edited. */
  force?: boolean;
};

export type WriteSkillResult = {
  dir: string;
  /** An earlier install of the same skill was replaced. */
  replaced: boolean;
};

/** `rel` under `root`, refusing anything that resolves outside it. */
function resolveInside(root: string, rel: string): string {
  const base = resolve(root);
  const target = resolve(base, ...rel.split("/"));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to write outside ${base}: ${rel}`);
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs a skill as `<root>/<name>/`, all or nothing.
 *
 * The files are written into a fresh sibling directory first and moved into
 * place only when every one of them is down, so a failed install leaves
 * nothing half-written. An existing directory is replaced only if this CLI
 * installed it, from the same slug, and its files are unedited (or `force`);
 * anything else is refused, because a directory we did not create is not ours
 * to delete.
 */
export async function writeSkillDir(
  input: WriteSkillInput,
): Promise<WriteSkillResult> {
  const { root, name, files, metadata } = input;
  if (!isSafeSkillDirName(name)) {
    throw new Error(`'${name}' is not a valid skill name`);
  }
  const target = resolveInside(root, name);

  let replaced = false;
  if (await exists(target)) {
    const existing = await readMetadata(target);
    if (!existing) {
      throw new InstallConflictError(
        "NOT_OURS",
        target,
        `${target} already exists and was not installed by sourceweft. Move or remove it first.`,
      );
    }
    if (
      existing.slug !== metadata.slug ||
      existing.registry !== metadata.registry
    ) {
      throw new InstallConflictError(
        "OTHER_SOURCE",
        target,
        `${target} holds '${existing.slug}' from ${existing.registry}, not '${metadata.slug}'.`,
      );
    }
    if (
      !input.force &&
      hasLocalChanges(await detectLocalChanges(target, existing))
    ) {
      throw new InstallConflictError(
        "LOCALLY_MODIFIED",
        target,
        `${target} has local changes. Re-run with --force to overwrite them.`,
      );
    }
    replaced = true;
  }

  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".sourceweft-tmp-"));
  const backup = `${staging}.old`;
  try {
    for (const file of files) {
      if (!isSafeBundlePath(file.path) || file.path === METADATA_FILE) {
        throw new Error(`Refusing to write unsafe path: ${file.path}`);
      }
      const destination = resolveInside(staging, file.path);
      await mkdir(dirname(destination), { recursive: true });
      // `wx`: a path listed twice must fail rather than overwrite itself.
      await writeFile(destination, file.bytes, { flag: "wx" });
    }
    await writeFile(join(staging, METADATA_FILE), serializeMetadata(metadata), {
      flag: "wx",
    });

    if (replaced) {
      await rename(target, backup);
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (replaced) {
        await rename(backup, target);
      }
      throw error;
    }
    if (replaced) {
      await rm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { dir: target, replaced };
}
