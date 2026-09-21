import { unzipSync } from "fflate";
import { isSafeBundlePath } from "./paths";
import { SKILL_STORAGE_LIMITS } from "./limits";

/**
 * Reads the skill files out of a GitHub zipball, in memory.
 *
 * Nothing here touches a filesystem: entries are decompressed straight into
 * buffers, and an entry is only ever a name plus bytes. A symlink in the
 * archive is therefore just a small regular file holding its target text — the
 * caller never creates a link from archive data, so there is no link to
 * escape through. What the caller does with the `path`s is its own business,
 * which is why every returned path has already passed `isSafeBundlePath`.
 *
 * The compressed size alone does not bound a decompression bomb, so the
 * declared sizes (which the archive controls, and may lie about) are checked
 * before any entry is inflated, and the real sizes are checked again after.
 */

export type SkillArchiveErrorCode =
  "ARCHIVE_INVALID" | "ARCHIVE_TOO_LARGE" | "UNSAFE_PATH";

export class SkillArchiveError extends Error {
  readonly code: SkillArchiveErrorCode;

  constructor(code: SkillArchiveErrorCode, message: string) {
    super(message);
    this.name = "SkillArchiveError";
    this.code = code;
  }
}

export type SkillArchiveLimits = {
  /** File entries considered across the whole repository. */
  maxEntries: number;
  /** Per-file ceiling, declared and actual. */
  maxFileBytes: number;
  /** Cumulative uncompressed ceiling across every entry read. */
  maxTotalBytes: number;
};

export const DEFAULT_SKILL_ARCHIVE_LIMITS: SkillArchiveLimits = Object.freeze({
  maxEntries: 20_000,
  maxFileBytes: SKILL_STORAGE_LIMITS.maxFileBytes,
  maxTotalBytes: SKILL_STORAGE_LIMITS.maxBundleBytes,
});

export type ReadSkillArchiveOptions = {
  /**
   * The skill's directory relative to the repository root (`""` for a skill at
   * the root). Only entries under it are read; returned paths are relative to
   * it, which is the bundle root.
   */
  subpath?: string;
  /**
   * Narrows to the bundle paths the caller wants (e.g. a manifest). Entries it
   * rejects are never inflated, and are not held to the path-safety rule —
   * they are never read, so they cannot do harm.
   */
  keep?: (bundlePath: string) => boolean;
  limits?: Partial<SkillArchiveLimits>;
};

/**
 * GitHub nests every entry under one `<repo>-<sha>/` directory. Strips it;
 * returns null for the root itself, directories, and anything with no root.
 */
function toRepoRelativePath(entryName: string): string | null {
  if (entryName.endsWith("/")) {
    return null;
  }
  const slash = entryName.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const rest = entryName.slice(slash + 1);
  return rest.length > 0 ? rest : null;
}

function normalizeSubpath(subpath: string | undefined): string {
  const trimmed = (subpath ?? "").replace(/^\/+|\/+$/gu, "");
  if (trimmed !== "" && !isSafeBundlePath(trimmed)) {
    throw new SkillArchiveError(
      "UNSAFE_PATH",
      `Skill subpath '${subpath}' is not a safe relative path`,
    );
  }
  return trimmed;
}

/**
 * Returns bundle-root-relative path → bytes for every entry under `subpath`
 * that `keep` selects. Throws `SkillArchiveError` on a bad archive, an
 * oversize entry, or a kept entry whose path is unsafe.
 */
export function readSkillArchive(
  zip: Uint8Array,
  options: ReadSkillArchiveOptions = {},
): Map<string, Uint8Array> {
  const limits = { ...DEFAULT_SKILL_ARCHIVE_LIMITS, ...options.limits };
  const subpath = normalizeSubpath(options.subpath);
  const prefix = subpath === "" ? "" : `${subpath}/`;
  const keep = options.keep ?? (() => true);

  let entries = 0;
  let declaredTotal = 0;
  let rejection: SkillArchiveError | null = null;
  // Maps the archive's own entry name to the bundle path it was kept under, so
  // the second pass does not re-derive (and cannot disagree about) either.
  const kept = new Map<string, string>();

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zip, {
      filter: (file) => {
        if (rejection) {
          return false;
        }
        const repoPath = toRepoRelativePath(file.name);
        if (repoPath === null) {
          return false;
        }
        entries += 1;
        if (entries > limits.maxEntries) {
          rejection = new SkillArchiveError(
            "ARCHIVE_TOO_LARGE",
            `Repository archive exceeds the maximum allowed ${limits.maxEntries} files`,
          );
          return false;
        }
        if (!repoPath.startsWith(prefix)) {
          return false;
        }
        const bundlePath = repoPath.slice(prefix.length);
        if (bundlePath === "" || !keep(bundlePath)) {
          return false;
        }
        if (!isSafeBundlePath(bundlePath)) {
          rejection = new SkillArchiveError(
            "UNSAFE_PATH",
            `Archive entry '${bundlePath}' is not a safe relative path`,
          );
          return false;
        }
        if (file.originalSize > limits.maxFileBytes) {
          rejection = new SkillArchiveError(
            "ARCHIVE_TOO_LARGE",
            `File '${bundlePath}' exceeds the per-file size limit`,
          );
          return false;
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > limits.maxTotalBytes) {
          rejection = new SkillArchiveError(
            "ARCHIVE_TOO_LARGE",
            "Skill expands beyond the maximum allowed size",
          );
          return false;
        }
        kept.set(file.name, bundlePath);
        return true;
      },
    });
  } catch (error) {
    throw new SkillArchiveError(
      "ARCHIVE_INVALID",
      `Archive could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (rejection) {
    throw rejection;
  }

  const files = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const [entryName, bytes] of Object.entries(unzipped)) {
    const bundlePath = kept.get(entryName);
    if (bundlePath === undefined) {
      continue;
    }
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new SkillArchiveError(
        "ARCHIVE_TOO_LARGE",
        `File '${bundlePath}' exceeds the per-file size limit`,
      );
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > limits.maxTotalBytes) {
      throw new SkillArchiveError(
        "ARCHIVE_TOO_LARGE",
        "Skill expands beyond the maximum allowed size",
      );
    }
    files.set(bundlePath, bytes);
  }
  return files;
}
