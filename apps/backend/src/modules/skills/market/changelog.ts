import type { SkillManifestJson } from "@sourceweft/db";
import { parseGithubStoragePointer } from "../storage/source-pointer";

/**
 * What changed from one published version of a community skill to the next,
 * worked out from what both versions recorded at ingest — no repository is
 * read. Files are compared by path and content hash; "new scripts" and "new
 * flags" are what the newer version can do that the older one could not,
 * which is the part a person deciding whether to take the update cares about.
 *
 * Pure, so the public version list, the workspace update notice and the admin
 * listing queue all say the same thing about the same pair of versions.
 */

export type SkillVersionChangelog = {
  added: string[];
  removed: string[];
  modified: string[];
  /** Scripts in the newer version that the older one did not ship as scripts. */
  newScripts: string[];
  /** Scan flags on the newer version that the older one did not carry. */
  newFlags: string[];
  /** GitHub's comparison of the two pinned commits, when both are known. */
  compareUrl: string | null;
};

export type ChangelogFile = {
  path: string;
  contentHash: string;
  role?: "model-readable" | "script" | "asset";
};

export type ChangelogVersion = {
  storagePointer: string | null;
  files: readonly ChangelogFile[];
  flags: readonly string[];
};

/**
 * A version as the changelog reads it, from its manifest alone: the file
 * manifest (path, hash and role) and the scan flags. `files` replaces the
 * manifest's list when the caller already holds the version's file rows —
 * their hashes are the stored ones; roles still come from the manifest.
 */
export function changelogVersion(input: {
  storagePointer: string | null;
  manifestJson: SkillManifestJson;
  files?: ReadonlyArray<{ path: string; contentHash: string }>;
}): ChangelogVersion {
  const registry = input.manifestJson.registry;
  const manifest = registry?.fileManifest ?? [];
  const roles = new Map(manifest.map((file) => [file.path, file.role]));
  return {
    storagePointer: input.storagePointer,
    files: input.files
      ? input.files.map((file) => ({
          path: file.path,
          contentHash: file.contentHash,
          role: roles.get(file.path),
        }))
      : manifest.map((file) => ({
          path: file.path,
          contentHash: file.sha256,
          role: file.role,
        })),
    flags: registry?.scan?.flags ?? [],
  };
}

// The same digest can be stored as `sha256:ABC…` or `abc…`; either way it is
// the same file, and calling it modified would be noise.
function sameHash(a: string, b: string): boolean {
  const normal = (value: string) =>
    value
      .trim()
      .replace(/^sha-?256[:=-]/i, "")
      .toLowerCase();
  return normal(a) === normal(b);
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `https://github.com/<owner>/<repo>/compare/<old>...<new>` when both versions
 * are pinned to commits of the same repository, else null. The owner and
 * repository come from the newer pointer; GitHub treats their case loosely, so
 * the comparison does too.
 */
export function githubCompareUrl(
  previousPointer: string | null,
  currentPointer: string | null,
): string | null {
  const previous = parseGithubStoragePointer(previousPointer);
  const current = parseGithubStoragePointer(currentPointer);
  if (!previous || !current) return null;
  if (
    previous.owner.toLowerCase() !== current.owner.toLowerCase() ||
    previous.repo.toLowerCase() !== current.repo.toLowerCase() ||
    previous.commitSha === current.commitSha
  ) {
    return null;
  }
  return `https://github.com/${current.owner}/${current.repo}/compare/${previous.commitSha}...${current.commitSha}`;
}

export function diffSkillVersions(
  previous: ChangelogVersion,
  current: ChangelogVersion,
): SkillVersionChangelog {
  const before = new Map(previous.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const added: string[] = [];
  const modified: string[] = [];
  const newScripts: string[] = [];
  for (const file of after.values()) {
    const old = before.get(file.path);
    if (!old) added.push(file.path);
    else if (!sameHash(old.contentHash, file.contentHash))
      modified.push(file.path);
    // A file that was there as a reference and is a script now counts as a
    // new script: what matters is that it can now be run.
    if (file.role === "script" && old?.role !== "script") {
      newScripts.push(file.path);
    }
  }
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const known = new Set(previous.flags);
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    modified: modified.sort(byPath),
    newScripts: newScripts.sort(byPath),
    newFlags: [...new Set(current.flags.filter((flag) => !known.has(flag)))],
    compareUrl: githubCompareUrl(
      previous.storagePointer,
      current.storagePointer,
    ),
  };
}
