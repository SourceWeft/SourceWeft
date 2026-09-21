import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * `rel` (a `/`-separated bundle path) under `root`, refusing anything that
 * resolves outside it. Asks `path.relative` rather than comparing string
 * prefixes: that stays right when `root` ends in a separator already (a drive
 * root such as `D:\`), when the two differ in case (Windows), and when `rel`
 * carries a drive of its own (`E:x`, which `resolve` follows to another drive).
 */
export function resolveInside(root: string, rel: string): string {
  const base = resolve(root);
  const target = resolve(base, ...rel.split("/"));
  const from = relative(base, target);
  if (from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) {
    throw new Error(`Refusing to write outside ${base}: ${rel}`);
  }
  return target;
}

/** Codes Windows gives a rename that fails only because something has the path open. */
const BUSY_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Pauses between attempts: six tries over about three seconds, then give up. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [
  50, 100, 200, 400, 800, 1600,
];

export type RenameRetryOptions = {
  /** Replaceable in tests. */
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
  delaysMs?: readonly number[];
};

/**
 * `rename`, tried again a few times on Windows when it fails with EPERM, EBUSY
 * or EACCES. Renaming a directory fails there while any file inside it is open
 * — and an antivirus scanner, the search indexer or an editor watching the
 * skills directory opens files for a moment right after they are written. It is
 * a transient failure, so a short bounded wait clears it. Elsewhere those codes
 * mean a real permission problem, so nothing is retried and the first error
 * stands.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const doRename = options.rename ?? rename;
  const delays =
    (options.platform ?? process.platform) === "win32"
      ? (options.delaysMs ?? RENAME_RETRY_DELAYS_MS)
      : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await doRename(from, to);
    } catch (error) {
      const delay = delays[attempt];
      const code = (error as NodeJS.ErrnoException).code;
      if (
        delay === undefined ||
        code === undefined ||
        !BUSY_RENAME_CODES.has(code)
      ) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, delay));
    }
  }
}

/** Deleting a tree can hit the same transient locks as renaming one. */
export const REMOVE_TREE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

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
      await renameWithRetry(target, backup);
    }
    try {
      await renameWithRetry(staging, target);
    } catch (error) {
      if (replaced) {
        await renameWithRetry(backup, target);
      }
      throw error;
    }
    if (replaced) {
      // The new install is already in place, so failing to delete the old one
      // (Windows: a file in it is still open) must not fail the install. What
      // is left is a stale `.sourceweft-tmp-*.old` directory, which `doctor`
      // reports as safe to delete.
      await rm(backup, REMOVE_TREE_OPTIONS).catch(() => undefined);
    }
  } catch (error) {
    // Best effort: a cleanup failure must not hide why the install failed.
    await rm(staging, REMOVE_TREE_OPTIONS).catch(() => undefined);
    throw error;
  }
  return { dir: target, replaced };
}
