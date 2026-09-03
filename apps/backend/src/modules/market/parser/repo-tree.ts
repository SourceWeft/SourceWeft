import path from "node:path";
import {
  downloadRepoZip,
  listZipEntries,
  readZipEntries,
  resolvePinnedGitHubSource,
  type PinnedGitHubSource,
} from "./github-zip";

/**
 * A repository as an in-memory tree, standing in for the extracted directory
 * the static parser used to walk.
 *
 * Ingest used to `tar -xzf` a submitted repo into `os.tmpdir()` and read it
 * with `node:fs`, which put an archive decoder, a `tar` subprocess and
 * attacker-named paths on the app host for every submission. Nothing here
 * writes a file, so extraction-time path traversal and symlink escape are
 * absent rather than guarded.
 *
 * Paths stay VIRTUAL absolute strings under `VIRTUAL_REPO_ROOT`, which is what
 * keeps the change small: the parser's `path.join` / `path.relative` arithmetic
 * is unchanged, and only the three primitives that actually touched the disk —
 * exists, read, walk — are re-pointed here.
 */

/** Synthetic root. Never created; only ever a prefix for map keys. */
export const VIRTUAL_REPO_ROOT = "/__repo__";

export class RepoTree {
  /** Virtual absolute path -> raw bytes. */
  private readonly files: Map<string, Buffer>;

  constructor(filesByRepoPath: Map<string, Buffer>) {
    this.files = new Map(
      [...filesByRepoPath].map(([repoPath, bytes]) => [
        `${VIRTUAL_REPO_ROOT}/${repoPath}`,
        bytes,
      ]),
    );
  }

  exists(filePath: string): boolean {
    if (this.files.has(filePath)) {
      return true;
    }
    // A directory "exists" when anything sits under it — the parser probes both.
    const prefix = `${filePath}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  readText(filePath: string): string {
    return this.files.get(filePath)?.toString("utf8") ?? "";
  }

  sizeOf(filePath: string): number | null {
    return this.files.get(filePath)?.byteLength ?? null;
  }

  /** Immediate entry names under a directory, files and subdirectories alike. */
  readDirNames(directory: string): string[] {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const segment = key.slice(prefix.length).split("/")[0];
      if (segment) {
        names.add(segment);
      }
    }
    return [...names].sort();
  }

  /**
   * Every file under `root`, skipping directories the caller wants ignored and
   * stopping at `limit`. Sorted so ingest is deterministic — the old readdir
   * walk was filesystem-order and could rank differently run to run.
   */
  walkFiles(input: {
    root: string;
    limit: number;
    ignoredDirectories: ReadonlySet<string>;
  }): string[] {
    const prefix = input.root.endsWith("/") ? input.root : `${input.root}/`;
    const found: string[] = [];
    for (const key of [...this.files.keys()].sort()) {
      if (found.length >= input.limit) {
        break;
      }
      if (!key.startsWith(prefix)) {
        continue;
      }
      const segments = key.slice(prefix.length).split("/");
      const directories = segments.slice(0, -1);
      if (
        directories.some((segment) => input.ignoredDirectories.has(segment))
      ) {
        continue;
      }
      found.push(key);
    }
    return found;
  }
}

export type ReadGitHubRepository = PinnedGitHubSource & {
  /** Virtual dir the parser walks: the repo root, or the submitted subpath. */
  workDir: string;
  rootDir: string;
  /** The ref as submitted (a branch, tag, or sha) before pinning. */
  requestedRef: string;
  /** What the fetch actually used — always the pinned commit. */
  resolvedRef: string;
  tree: RepoTree;
};

/**
 * Fetch a repository and return it as a virtual tree. Replaces
 * `prepareGitHubRepository` for callers that only ever read.
 */
export async function readGitHubRepository(
  sourceUrl: string,
): Promise<ReadGitHubRepository> {
  const source = await resolvePinnedGitHubSource(sourceUrl);
  const zip = await downloadRepoZip(source);
  const entries = await listZipEntries(zip);
  const wanted = new Set(entries.map((entry) => entry.path));
  // A single oversized asset in a repository is not a reason to refuse the
  // whole submission — the parser skipped such files anyway once it stat'd
  // them. The cumulative ceiling still applies and still fails hard.
  const files = await readZipEntries(
    zip,
    (entryPath) => wanted.has(entryPath),
    {
      oversize: "skip",
    },
  );

  return {
    ...source,
    requestedRef: source.ref ?? source.commitSha,
    resolvedRef: source.commitSha,
    rootDir: VIRTUAL_REPO_ROOT,
    workDir: source.subpath
      ? path.posix.join(VIRTUAL_REPO_ROOT, source.subpath)
      : VIRTUAL_REPO_ROOT,
    tree: new RepoTree(files),
  };
}
