import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  cleanupGitHubRepository,
  prepareGitHubRepository,
} from "../../market/parser/github";
import type { PreparedGitHubRepository } from "../../market/types";
import { RegistrySubmissionError } from "./errors";

/**
 * Stage 2 — Read (fetch + extract + locate SKILL.md).
 * docs/architecture/skill-registry-index.md §3 Stage 2 / build phase R2.
 *
 * TODO(skill-registry R2 §Stage2/§7.0): the fetch + archive-extract below runs
 * on the app HOST today, reusing the hardened `market/parser/github.ts`
 * (`prepareGitHubRepository` = github.com-allowlisted `normalizeGitHubSource`,
 * `resolveCommitSha` immutable pin, bounded download, `inspectArchiveEntries`
 * symlink/traversal/file-count caps, `tar --no-same-owner`). The design's
 * end-state moves this into the egress-allowlisted *ingestion sandbox*
 * (`networkPolicy: 'ingestion-github'`, `packages/sandbox-provider-daytona`) so
 * untrusted third-party bytes are never extracted on the host. Two R0 TODOs gate
 * a faithful sandboxed egress allowlist and are intentionally NOT touched here:
 *   (1) `@langchain/daytona@0.2.0`'s wrapper drops `networkBlockAll` /
 *       `networkAllowList` (sandbox-provider-daytona/daytona-provider.ts ~L554) —
 *       end-to-end enforcement needs the wrapper to forward them; and
 *   (2) Daytona's allow-list is CIDR-not-hostname (same file ~L25-51), so the
 *       `ingestion-github` policy is expressed as GitHub's published IP ranges,
 *       which drift and need a live `api.github.com/meta` resolver.
 */

/**
 * Interim host-side DoS bounds on the ANALYZED skill bundles (the archive-level
 * caps live in `parser/github.ts`). `maxSkillFileBytes` matches the runtime
 * per-file ceiling (`pointer-bundle.ts` MAX_POINTER_FILE_BYTES) so a file we
 * index can always be re-fetched within the same cap.
 */
export const REGISTRY_READ_LIMITS = Object.freeze({
  maxSkillFileBytes: 512 * 1024, // 512 KiB — mirrors MAX_POINTER_FILE_BYTES
  maxSkillFilesPerBundle: 200,
  maxSkillsPerRepo: 25,
});

/** Directories that are never skill content (mirrors builtin.ts denylist). */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
/** Containers under which per-skill subdirectories live (§3 Stage 2). */
const SKILL_CONTAINERS = ["skills", ".claude/skills", ".agents/skills"];

export type DiscoveredSkillFile = {
  /** Path relative to the skill BUNDLE root (e.g. `SKILL.md`, `scripts/run.py`). */
  bundlePath: string;
  /** sha256 over the raw file bytes — the runtime re-verifies against this. */
  sha256: string;
  sizeBytes: number;
  contentText: string;
};

export type DiscoveredSkill = {
  /**
   * Skill directory relative to the REPO ROOT — this becomes the pointer's
   * `#<subpath>`. Empty string when the skill sits at the repo root.
   */
  repoSubpath: string;
  /** Last path segment of the skill dir — the expected frontmatter `name`. */
  dirName: string;
  files: DiscoveredSkillFile[];
};

export type ReadRegistryResult = {
  /** Caller owns cleanup: `cleanupGitHubRepository(source)` in a `finally`. */
  source: PreparedGitHubRepository;
  /** Immutable 40-hex commit the submission is pinned to. */
  commitSha: string;
  skills: DiscoveredSkill[];
};

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function isFile(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((entry) => entry.isFile())
    .catch(() => false);
}

async function listSubdirectories(dir: string): Promise<string[]> {
  return readdir(dir, { withFileTypes: true })
    .then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    )
    .catch(() => []);
}

/**
 * Locate every skill directory (one containing a `SKILL.md`) reachable from the
 * work dir: the root itself, plus one level under `skills/`, `.claude/skills/`,
 * `.agents/skills/`. A repo may ship multiple skills (§3 Stage 2).
 */
async function discoverSkillDirectories(workDir: string): Promise<string[]> {
  const dirs: string[] = [];
  if (await isFile(path.join(workDir, "SKILL.md"))) {
    dirs.push(workDir);
  }
  for (const container of SKILL_CONTAINERS) {
    const containerDir = path.join(workDir, container);
    for (const name of await listSubdirectories(containerDir)) {
      const skillDir = path.join(containerDir, name);
      if (await isFile(path.join(skillDir, "SKILL.md"))) {
        dirs.push(skillDir);
      }
    }
  }
  return dirs;
}

async function collectBundleFilePaths(
  skillDir: string,
  currentDir = skillDir,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      // Keep `scripts/` and other content dirs; drop build/vcs noise. Dotfiles
      // inside a skill are content (e.g. `.env.example`), but dot *dirs* other
      // than the vcs one are treated as noise like builtin.ts does.
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      files.push(...(await collectBundleFilePaths(skillDir, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readSkillDirectory(
  rootDir: string,
  skillDir: string,
): Promise<DiscoveredSkill> {
  const absPaths = await collectBundleFilePaths(skillDir);
  if (absPaths.length > REGISTRY_READ_LIMITS.maxSkillFilesPerBundle) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `Skill bundle exceeds the ${REGISTRY_READ_LIMITS.maxSkillFilesPerBundle}-file limit`,
    );
  }

  const files: DiscoveredSkillFile[] = [];
  for (const absPath of absPaths) {
    const bytes = await readFile(absPath);
    if (bytes.byteLength > REGISTRY_READ_LIMITS.maxSkillFileBytes) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_TOO_LARGE",
        `Skill file '${path.relative(skillDir, absPath)}' exceeds the per-file size limit`,
      );
    }
    files.push({
      bundlePath: path.relative(skillDir, absPath).split(path.sep).join("/"),
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      // Read as UTF-8 for static analysis only; the sha256 above is over the
      // raw bytes, so runtime integrity verification stays byte-exact.
      contentText: bytes.toString("utf8"),
    });
  }

  const repoSubpath = path
    .relative(rootDir, skillDir)
    .split(path.sep)
    .join("/");
  return {
    repoSubpath: repoSubpath === "." ? "" : repoSubpath,
    dirName: path.basename(skillDir),
    files,
  };
}

/**
 * Fetch + extract a submitted GitHub repo and return every discovered skill
 * bundle with per-file digests. The commit is pinned to an immutable 40-hex sha
 * (rejected otherwise — the pointer must be frozen, §2/§5). The caller owns temp
 * cleanup; on any failure here we clean up before re-throwing.
 */
export async function readRegistrySkillsFromGitHub(
  repoUrl: string,
): Promise<ReadRegistryResult> {
  const source = await prepareGitHubRepository(repoUrl);
  try {
    // Canonical lowercase so the pointer's #sha matches the runtime's
    // (pointer-bundle.ts lowercases on parse) and the raw URL is stable.
    const commitSha = source.commitSha?.toLowerCase();
    if (!commitSha || !COMMIT_SHA_PATTERN.test(commitSha)) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_UNPINNED",
        "Could not resolve an immutable commit SHA to pin this submission",
      );
    }

    const skillDirs = await discoverSkillDirectories(source.workDir);
    if (skillDirs.length === 0) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_NOT_SKILL",
        "No SKILL.md found at the repo root or under skills/, .claude/skills/, .agents/skills/",
      );
    }
    if (skillDirs.length > REGISTRY_READ_LIMITS.maxSkillsPerRepo) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_TOO_LARGE",
        `Repository ships more than the ${REGISTRY_READ_LIMITS.maxSkillsPerRepo}-skill limit`,
      );
    }

    const skills = await Promise.all(
      skillDirs.map((skillDir) => readSkillDirectory(source.rootDir, skillDir)),
    );
    return { source, commitSha, skills };
  } catch (error) {
    await cleanupGitHubRepository(source);
    throw error;
  }
}
