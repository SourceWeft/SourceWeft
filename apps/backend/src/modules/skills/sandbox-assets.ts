import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { RuntimeAssetPlan } from "@sourceweft/builtin-tool-sandbox";
import { SOURCEWEFT_SKILLS_ROOT } from "@sourceweft/builtin-tool-sandbox";
import type { EnabledSkillDescriptor } from "./types";
import { ContentError } from "../content/errors";

/**
 * Skill bundles as sandbox runtime assets
 * (docs/architecture/sandbox-skill-staging.md §convergence,
 * docs/architecture/sandbox-runtime-assets.md §6).
 *
 * Each enabled skill's bundle is packed into a deterministic zip so the
 * runtime-asset engine can stage it to the fixed contract path
 * `/skills/<name>/` and verify it by sha256 in-sandbox. Determinism (sorted
 * entries, fixed mtime, pure-JS compressor) makes the digest a stable content
 * key: unchanged bundles hit the sandbox stamp and never re-transfer.
 */

/** Mirrors the engine's SAFE_SEGMENT — a name failing this cannot be staged. */
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

/**
 * Per-skill staging caps. A selected skill over these limits fails preparation;
 * silently dropping it would change the turn's declared instruction contract.
 */
const MAX_SKILL_BUNDLE_FILES = 200;
const MAX_SKILL_BUNDLE_TOTAL_BYTES = 2 * 1024 * 1024;

/** Fixed timestamp for deterministic zip output (zip epoch is 1980). */
const ZIP_MTIME = new Date("2000-01-01T00:00:00Z");

const ZIP_CACHE_LIMIT = 100;

type SkillZip = { sha256: string; content: Uint8Array };

/** Content-keyed zip cache: repeat turns with unchanged bundles never rezip. */
const zipCache = new Map<string, SkillZip>();

function safeBundleFilePath(path: string) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("~") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/u.test(path)
  );
}

/**
 * The engine requires `version` to be a safe path-ish segment. Skill version
 * strings are usually semver and pass through unchanged; anything else is
 * normalized deterministically. Content authority is the sha256 either way —
 * the stamp comparison includes it, so a lossy version string can never serve
 * stale content.
 */
function safeVersionSegment(version: string) {
  const normalized = version.replace(/[^a-zA-Z0-9._-]/gu, "-");
  return SAFE_SEGMENT.test(normalized) ? normalized : `v-${normalized}`;
}

function contentKey(skill: EnabledSkillDescriptor) {
  const hash = createHash("sha256");
  for (const file of [...skill.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contentHash);
    hash.update("\0");
  }
  return `${skill.name}@${skill.version}:${hash.digest("hex")}`;
}

function buildSkillZip(skill: EnabledSkillDescriptor): SkillZip {
  const key = contentKey(skill);
  const cached = zipCache.get(key);
  if (cached) {
    return cached;
  }
  const encoder = new TextEncoder();
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const file of [...skill.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    entries[file.path] = [
      encoder.encode(file.contentText),
      { mtime: ZIP_MTIME },
    ];
  }
  const content = zipSync(entries, { mtime: ZIP_MTIME });
  const zip: SkillZip = {
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
  if (zipCache.size >= ZIP_CACHE_LIMIT) {
    const oldest = zipCache.keys().next().value;
    if (oldest !== undefined) {
      zipCache.delete(oldest);
    }
  }
  zipCache.set(key, zip);
  return zip;
}

/**
 * Build runtime-asset plans for selected skills. Any invalid or unstaged
 * bundle fails the turn before sandbox provisioning.
 */
export function buildSkillSandboxAssetPlans(
  skills: readonly EnabledSkillDescriptor[],
): RuntimeAssetPlan[] {
  const plans: RuntimeAssetPlan[] = [];
  for (const skill of skills) {
    const fail = (
      reason: string,
      details: Record<string, unknown> = {},
    ): never => {
      throw new ContentError(
        422,
        "SKILL_SANDBOX_ASSET_INVALID",
        `Selected skill '${skill.name}' cannot be staged in the sandbox`,
        {
          details: {
            reason,
            workspaceSkillId: skill.workspaceSkillId,
            skill: skill.name,
            ...details,
          },
          recoverable: false,
        },
      );
    };
    if (skill.files.length === 0) {
      fail("empty_bundle");
    }
    if (!SAFE_SEGMENT.test(skill.name)) {
      fail("unsafe_name");
    }
    if (!skill.files.some((file) => file.path === "SKILL.md")) {
      fail("missing_skill_md");
    }
    if (skill.files.length > MAX_SKILL_BUNDLE_FILES) {
      fail("too_many_files", { fileCount: skill.files.length });
    }
    if (!skill.files.every((file) => safeBundleFilePath(file.path))) {
      fail("unsafe_file_path");
    }
    const totalBytes = skill.files.reduce(
      (sum, file) => sum + file.sizeBytes,
      0,
    );
    if (totalBytes > MAX_SKILL_BUNDLE_TOTAL_BYTES) {
      fail("bundle_too_large", { totalBytes });
    }
    const { sha256, content } = buildSkillZip(skill);
    plans.push({
      name: skill.name,
      version: safeVersionSegment(skill.version),
      platform: "any",
      sha256,
      archive: "zip",
      entrypoint: "SKILL.md",
      installDir: `${SOURCEWEFT_SKILLS_ROOT}/${skill.name}`,
      loadContent: async () => content,
    });
  }
  return plans;
}
