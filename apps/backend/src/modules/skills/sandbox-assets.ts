import { createHash } from "node:crypto";
import type { RuntimeAssetPlan } from "@sourceweft/builtin-tool-sandbox";
import { SOURCEWEFT_SKILLS_ROOT } from "@sourceweft/builtin-tool-sandbox";
import type { EnabledSkillDescriptor } from "./types";
import { ContentError } from "../content/errors";
import {
  buildSkillBundleZip,
  presignSkillBundleUrl,
  readSkillBundle,
  SKILL_STORAGE_LIMITS,
} from "./storage";
import { logger } from "../../shared/logger";

/**
 * Skill bundles as sandbox runtime assets
 * (docs/architecture/sandbox-skill-staging.md §convergence,
 * docs/architecture/sandbox-runtime-assets.md §6).
 *
 * The runtime-asset engine stages one zip per skill to the fixed contract path
 * `/skills/<name>/` and verifies it by sha256 in-sandbox. Where the zip comes
 * from depends on where the skill's bytes live:
 * - an `object` version already HAS its bundle in object storage, written once
 *   at ingest. The plan points at it — the sandbox downloads it by presigned
 *   URL and checks the stored digest — and nothing is zipped per turn.
 * - `db_text` and `repo_builtin` skills have no stored bundle, so theirs is
 *   zipped in process, deterministically, the first time the sandbox asks.
 * Either way the digest is a stable content key: an unchanged bundle hits the
 * sandbox stamp and never re-transfers.
 */

/** Mirrors the engine's SAFE_SEGMENT — a name failing this cannot be staged. */
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

const ZIP_CACHE_LIMIT = 100;

type SkillZip = { sha256: string; content: Uint8Array };

/**
 * Content-keyed zip cache for the in-process path: repeat turns with an
 * unchanged bundle neither rezip nor re-read the bodies they would zip.
 */
const zipCache = new Map<string, SkillZip>();

export type SkillStagingRejection = {
  name: string;
  version: string;
  workspaceSkillId: string;
  reason: string;
  details: Record<string, unknown>;
};

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

/**
 * Why a skill cannot be staged, decided from its manifest alone (no body is
 * read), or null. The limits are the storage module's — the same ones ingest
 * enforces — so a skill that could be indexed can be staged.
 */
export function skillStagingRejection(
  skill: EnabledSkillDescriptor,
): SkillStagingRejection | null {
  const reject = (
    reason: string,
    details: Record<string, unknown> = {},
  ): SkillStagingRejection => ({
    name: skill.name,
    version: skill.version,
    workspaceSkillId: skill.workspaceSkillId,
    reason,
    details,
  });
  if (skill.files.length === 0) {
    return reject("empty_bundle");
  }
  if (!SAFE_SEGMENT.test(skill.name)) {
    return reject("unsafe_name");
  }
  if (!skill.files.some((file) => file.path === "SKILL.md")) {
    return reject("missing_skill_md");
  }
  if (skill.files.length > SKILL_STORAGE_LIMITS.maxFiles) {
    return reject("too_many_files", { fileCount: skill.files.length });
  }
  if (!skill.files.every((file) => safeBundleFilePath(file.path))) {
    return reject("unsafe_file_path");
  }
  const oversized = skill.files.find(
    (file) => file.sizeBytes > SKILL_STORAGE_LIMITS.maxFileBytes,
  );
  if (oversized) {
    return reject("file_too_large", {
      path: oversized.path,
      sizeBytes: oversized.sizeBytes,
    });
  }
  // A stored bundle is judged by what the sandbox will download; an in-process
  // one by what would go into the zip.
  const totalBytes =
    skill.bundle?.sizeBytes ??
    skill.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > SKILL_STORAGE_LIMITS.maxBundleBytes) {
    return reject("bundle_too_large", { totalBytes });
  }
  if (!skill.bundle && !skill.readFile) {
    return reject("content_unavailable");
  }
  return null;
}

function stagingError(rejection: SkillStagingRejection) {
  return new ContentError(
    422,
    "SKILL_SANDBOX_ASSET_INVALID",
    `Selected skill '${rejection.name}' cannot be staged in the sandbox`,
    {
      details: {
        reason: rejection.reason,
        workspaceSkillId: rejection.workspaceSkillId,
        skill: rejection.name,
        ...rejection.details,
      },
      recoverable: false,
    },
  );
}

/** Reads every body through the descriptor's loader — in-process skills only. */
async function buildSkillZip(skill: EnabledSkillDescriptor): Promise<SkillZip> {
  const key = contentKey(skill);
  const cached = zipCache.get(key);
  if (cached) {
    return cached;
  }
  const encoder = new TextEncoder();
  const files = await Promise.all(
    skill.files.map(async (file) => {
      // Builtins hand over bytes as they are on disk — fonts and images
      // included. A `db_text` skill has only text, by construction.
      if (skill.readBytes) {
        return { path: file.path, bytes: await skill.readBytes(file.path) };
      }
      const content = await skill.readFile!(file.path);
      if (!("text" in content)) {
        throw new Error(`'${file.path}' is binary and has no stored bundle`);
      }
      return { path: file.path, bytes: encoder.encode(content.text) };
    }),
  );
  const zip = buildSkillBundleZip(files);
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
 * The runtime-asset plan for one skill. Throws SKILL_SANDBOX_ASSET_INVALID for
 * a skill that cannot be staged; an in-process zip can also fail on a body read.
 */
export async function buildSkillSandboxAssetPlan(
  skill: EnabledSkillDescriptor,
): Promise<RuntimeAssetPlan> {
  const rejection = skillStagingRejection(skill);
  if (rejection) {
    throw stagingError(rejection);
  }
  const base = {
    name: skill.name,
    version: safeVersionSegment(skill.version),
    platform: "any",
    archive: "zip" as const,
    entrypoint: "SKILL.md",
    installDir: `${SOURCEWEFT_SKILLS_ROOT}/${skill.name}`,
  };
  const stored = skill.bundle;
  if (stored) {
    return {
      ...base,
      sha256: stored.sha256,
      // The sandbox downloads and verifies the digest itself; the upload rung
      // is the fallback for sandboxes without egress.
      // A presigned URL to an object that is gone would only fail inside the
      // sandbox, so the check happens here, before either rung is used.
      fetchUrl: async () => {
        await stored.ensureStored?.();
        return presignSkillBundleUrl(stored.objectKey);
      },
      loadContent: async () => {
        await stored.ensureStored?.();
        return readSkillBundle(stored.objectKey);
      },
    };
  }
  const { sha256, content } = await buildSkillZip(skill);
  return { ...base, sha256, loadContent: async () => content };
}

export async function buildSkillSandboxAssetPlans(
  skills: readonly EnabledSkillDescriptor[],
): Promise<RuntimeAssetPlan[]> {
  return Promise.all(skills.map(buildSkillSandboxAssetPlan));
}

/**
 * The skill bundles a turn's sandbox should hold — a set that can GROW while
 * the turn runs.
 *
 * It used to be a snapshot taken once from the skills the turn started with,
 * which made a skill installed mid-turn readable (the /skills mount is live)
 * but not runnable until the next turn. The sandbox manager asks for `plans()`
 * every time it stages and stages only what it has not attempted yet, so
 * registering the new bundle here is all an install has to do: it is staged
 * lazily, the first time a command references /skills.
 *
 * A skill that cannot be staged — over a limit, an unsafe path, no SKILL.md,
 * bodies that will not load — degrades ALONE. It is recorded in
 * `unstageable()`, which the sandbox manager folds into its staging outcomes as
 * a failure, so a command naming `/skills/<name>` gets the recoverable
 * SANDBOX_SKILL_STAGING_UNAVAILABLE while every other skill stages and the
 * skill's instructions stay readable through the /skills mount. Failing the
 * turn instead took down every sandbox turn of a workspace for one bad skill.
 *
 * Keyed by skill name because that is the staging path (`/skills/<name>/`): a
 * re-registered skill replaces its plan rather than staging twice.
 */
export class TurnSkillSandboxAssets {
  private readonly skillsByName = new Map<string, EnabledSkillDescriptor>();
  private readonly plansByName = new Map<string, Promise<RuntimeAssetPlan>>();
  private readonly rejectedByName = new Map<string, SkillStagingRejection>();

  /**
   * Registers the skills' bundles and reports the ones that cannot be staged.
   * Never throws and reads no body: plans are built when the sandbox asks.
   */
  add(skills: readonly EnabledSkillDescriptor[]): {
    rejected: SkillStagingRejection[];
  } {
    const rejected: SkillStagingRejection[] = [];
    for (const skill of skills) {
      this.plansByName.delete(skill.name);
      this.rejectedByName.delete(skill.name);
      const rejection = skillStagingRejection(skill);
      if (rejection) {
        this.skillsByName.delete(skill.name);
        rejected.push(rejection);
        this.reject(rejection);
      } else {
        this.skillsByName.set(skill.name, skill);
      }
    }
    return { rejected };
  }

  private reject(rejection: SkillStagingRejection) {
    this.rejectedByName.set(rejection.name, rejection);
    logger.warn("Skill cannot be staged in the sandbox; degrading it alone", {
      skill: rejection.name,
      version: rejection.version,
      workspaceSkillId: rejection.workspaceSkillId,
      reason: rejection.reason,
      ...rejection.details,
    });
  }

  /** The stageable skills by staging name — what `/skills/<name>` runs. */
  stagedSkills(): ReadonlyMap<string, EnabledSkillDescriptor> {
    return this.skillsByName;
  }

  /** True while there is anything a /skills command could be waiting on. */
  hasPlans() {
    return this.skillsByName.size > 0 || this.rejectedByName.size > 0;
  }

  async plans(): Promise<RuntimeAssetPlan[]> {
    const plans: RuntimeAssetPlan[] = [];
    for (const [name, skill] of [...this.skillsByName]) {
      let pending = this.plansByName.get(name);
      if (!pending) {
        pending = buildSkillSandboxAssetPlan(skill);
        this.plansByName.set(name, pending);
      }
      try {
        plans.push(await pending);
      } catch (error) {
        // Re-registered while this plan was being built: not ours to reject.
        if (this.plansByName.get(name) !== pending) {
          continue;
        }
        this.skillsByName.delete(name);
        this.plansByName.delete(name);
        this.reject({
          name,
          version: skill.version,
          workspaceSkillId: skill.workspaceSkillId,
          reason: "bundle_build_failed",
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return plans;
  }

  /** Skills the sandbox must treat as failed to stage, without trying. */
  unstageable(): Array<{ name: string; version: string; error: string }> {
    return [...this.rejectedByName.values()].map((rejection) => ({
      name: rejection.name,
      version: safeVersionSegment(rejection.version),
      error: `not stageable: ${rejection.reason}`,
    }));
  }
}
