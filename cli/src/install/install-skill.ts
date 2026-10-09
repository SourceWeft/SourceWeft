import { prepareInstalledFiles, INSTALL_FORMAT_VERSION } from "./metadata-view";
import type { SkillResponse } from "../registry/schema";
import { isSafeSkillDirName, sha256 } from "@sourceweft/skill-format";
import { fetchSkillFiles, type PinnedRepo } from "../source/github";
import { join } from "node:path";
import {
  detectLocalChanges,
  hasLocalChanges,
  readMetadata,
  type InstalledMetadata,
} from "./metadata";
import { checkManifest, verifyFiles, VerificationError } from "./verify";
import { writeSkillDir, type WriteSkillResult } from "./write";

export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSourceError";
  }
}

export type ResolvedSource = PinnedRepo & {
  repoUrl: string;
  /** The skill's directory in the repository; "" at the root. */
  subpath: string;
};

/**
 * Where the registry says a skill's bytes live. Only a skill pinned to a
 * commit of a github.com repository can be installed: anything else has no
 * immutable source to check the record against.
 */
export function resolveSource(skill: SkillResponse): ResolvedSource {
  const { repoUrl, commitSha, repoSubpath } = skill.source;
  if (!repoUrl || !commitSha || repoSubpath === null) {
    throw new UnsupportedSourceError(
      "This skill is not pinned to a GitHub commit, so it cannot be installed with the CLI.",
    );
  }
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new UnsupportedSourceError(
      `'${repoUrl}' is not a valid repository URL`,
    );
  }
  const [owner, rawRepo, ...rest] = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || !owner || !rawRepo || rest.length > 0) {
    throw new UnsupportedSourceError(
      `'${repoUrl}' is not a github.com repository`,
    );
  }
  return {
    owner,
    repo: rawRepo.replace(/\.git$/u, ""),
    commitSha,
    repoUrl,
    subpath: repoSubpath,
  };
}

export type InstallInput = {
  skill: SkillResponse;
  registry: string;
  /** The agent's skills directory to install under. */
  root: string;
  force?: boolean;
  /** Replaceable in tests. */
  download?: typeof fetchSkillFiles;
  now?: () => Date;
};

export type InstallResult = WriteSkillResult & {
  metadata: InstalledMetadata;
  /** The same commit was already installed and untouched, so nothing was done. */
  unchanged: boolean;
};

/**
 * Downloads the skill from its pinned upstream commit, holds every file to the
 * registry's record of it, and only then writes anything.
 */
export async function installFromRegistry(
  input: InstallInput,
): Promise<InstallResult> {
  const { skill } = input;
  const name = skill.skill.installName ?? skill.skill.name;
  if (!isSafeSkillDirName(name)) {
    throw new UnsupportedSourceError(
      `'${name}' cannot be used as a directory name, so this skill cannot be installed with the CLI.`,
    );
  }
  const source = resolveSource(skill);
  const manifest = skill.files.map((file) => ({
    path: file.path,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
  }));
  // Refuse a bad record before spending a download on it.
  const problems = checkManifest(manifest);
  if (problems.length > 0) {
    throw new VerificationError(problems);
  }

  // The same commit, already installed and unedited, is nothing to do — and
  // nothing worth a download.
  const dir = join(input.root, name);
  const existing = await readMetadata(dir);
  if (
    existing &&
    existing.slug === skill.skill.slug &&
    existing.registry === input.registry &&
    existing.source.commitSha === source.commitSha &&
    existing.version === skill.skill.version &&
    (existing.installFormatVersion ?? 0) >= INSTALL_FORMAT_VERSION &&
    !hasLocalChanges(await detectLocalChanges(dir, existing), {
      includeAdded: false,
    })
  ) {
    return { dir, replaced: false, metadata: existing, unchanged: true };
  }

  const wanted = new Set(manifest.map((file) => file.path));
  const download = input.download ?? fetchSkillFiles;
  const downloaded = await download(
    { owner: source.owner, repo: source.repo, commitSha: source.commitSha },
    { subpath: source.subpath, keep: (path) => wanted.has(path), manifest },
  );
  const verified = verifyFiles(manifest, downloaded);
  let prepared: ReturnType<typeof prepareInstalledFiles>;
  try {
    prepared = prepareInstalledFiles(verified, name, skill.skill.description);
  } catch (error) {
    throw new UnsupportedSourceError(
      `Skill metadata cannot be adapted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = prepared.files;

  const metadata: InstalledMetadata = {
    schema: 1,
    installFormatVersion: INSTALL_FORMAT_VERSION,
    ...(prepared.sourceFiles
      ? {
          sourceFiles: prepared.sourceFiles,
          originalSkillMd: prepared.originalSkillMd,
        }
      : {}),
    registry: input.registry,
    slug: skill.skill.slug,
    ...(skill.skill.installRef ? { installRef: skill.skill.installRef } : {}),
    version: skill.skill.version,
    source: {
      repoUrl: source.repoUrl,
      commitSha: source.commitSha,
      subpath: source.subpath,
    },
    license: skill.skill.license,
    files: Object.fromEntries(
      files.map((file) => [file.path, sha256(file.bytes)]),
    ),
    installedAt: (input.now?.() ?? new Date()).toISOString(),
    installedVia: "cli",
  };
  const written = await writeSkillDir({
    root: input.root,
    name,
    files,
    metadata,
    ...(input.force ? { force: true } : {}),
  });
  return { ...written, metadata, unchanged: false };
}
