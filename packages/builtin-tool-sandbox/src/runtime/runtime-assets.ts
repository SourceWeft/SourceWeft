/**
 * Runtime-asset resolution ladder — platform-managed versioned binaries inside
 * sandboxes (docs/architecture/sandbox-runtime-assets.md).
 *
 * The engine is provider-agnostic on purpose: it programs against the four
 * session primitives every provider already has (execute / uploadFiles /
 * downloadFiles / rootDir). Acceleration rungs that need vendor features
 * (image manifests, creation-time volume mounts) slot in ahead of these
 * without changing this file's contract — P1 ships the universal rungs:
 *
 *   image   — the sandbox image pre-baked the asset and declares it via env
 *             (the primary path under the image-first policy; everything
 *             below is insurance for when the image assumption falls through)
 *   stamp   — the asset is already staged in this sandbox (idempotency)
 *   fetch   — in-sandbox curl from a presigned platform-cache URL
 *   upload  — session uploadFiles streamed from the platform cache
 *
 * Assets are immutable at (name, version, platform) and sha256-verified on
 * every rung, so a stamped directory never needs re-validation: the stamp is
 * written only after content landed and verified (crash-safe — a partial
 * stage leaves no stamp and is restaged from scratch).
 */

const STAMP_FILE = ".sourceweft-asset.json";

/** P1 asset root: workspace-relative, zero preconditions on any provider.
 * P2's image rung will prefer a pre-created root-level /assets. */
const ASSETS_DIR = ".sourceweft-assets";

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_ENV_VAR = /^[A-Z_][A-Z0-9_]*$/u;

export type RuntimeAssetSessionLike = {
  readonly rootDir: string;
  execute(
    command: string,
    options?: { toolCallId?: string },
  ): Promise<{ exitCode: number | null; output: string; truncated?: boolean }>;
  uploadFiles(
    files: Array<[path: string, content: Uint8Array]>,
  ): Promise<Array<{ path: string; error?: string | null }>>;
  downloadFiles(
    paths: string[],
  ): Promise<
    Array<{ path: string; content: Uint8Array | null; error?: string | null }>
  >;
};

export type RuntimeAssetPlan = {
  /** Safe path segment; catalog key. */
  name: string;
  version: string;
  /** e.g. "linux-x64" — informational + stamp field in P1. */
  platform: string;
  /** sha256 of the archive, hex. Verified in-sandbox on every staging rung. */
  sha256: string;
  archive: "zip";
  /** Relative path of the executable/entry inside the unpacked archive. */
  entrypoint: string;
  /** Relative paths to chmod +x after unpack (entrypoint is always included). */
  makeExecutable?: readonly string[];
  /**
   * Rung "image": env var the sandbox image sets to the baked asset's
   * entrypoint (e.g. SOURCEWEFT_REMOTION_BROWSER). Probed with `test -x`
   * before any staging — a hit costs one command and no bytes.
   */
  imagePathEnvVar?: string;
  /** Rung "fetch": short-lived URL to the platform cache. */
  fetchUrl?: () => Promise<string | null>;
  /** Rung "upload": archive bytes from the platform cache. */
  loadContent?: () => Promise<Uint8Array | null>;
  /**
   * Absolute install directory override. Default placement is
   * `<rootDir>/.sourceweft-assets/<name>/<version>/` — version-nested, so a
   * new version lands beside the old. Contract-rooted assets (skill bundles
   * at `/skills/<name>/`, docs/architecture/sandbox-skill-staging.md) need a
   * FIXED path independent of version: consumers reference it verbatim. With
   * installDir set, the plan stages to exactly this directory; the stamp's
   * version+sha comparison makes a version bump restage over the same path
   * (rm -rf in the promote step replaces the old content atomically).
   * The parent directory must already exist (image contract or a writable
   * root) — a failed staging mkdir is an ordinary rung failure, which IS the
   * probe for that contract.
   */
  installDir?: string;
};

export type RuntimeAssetResolution = {
  name: string;
  version: string;
  ok: boolean;
  rung?: "image" | "stamp" | "fetch" | "upload";
  entrypointPath?: string;
  ms: number;
  bytes?: number;
  error?: string;
};

type RuntimeAssetLogger = {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
};

function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function assetStamp(plan: RuntimeAssetPlan, rung: "fetch" | "upload") {
  return {
    name: plan.name,
    version: plan.version,
    platform: plan.platform,
    sha256: plan.sha256,
    entrypoint: plan.entrypoint,
    rung,
    stagedAtIso: new Date().toISOString(),
  };
}

function validatePlan(plan: RuntimeAssetPlan): string | null {
  if (!SAFE_SEGMENT.test(plan.name)) return `unsafe asset name: ${plan.name}`;
  if (!SAFE_SEGMENT.test(plan.version)) {
    return `unsafe asset version: ${plan.version}`;
  }
  if (!SHA256_HEX.test(plan.sha256)) return "asset sha256 must be 64-char hex";
  if (plan.entrypoint.includes("..") || plan.entrypoint.startsWith("/")) {
    return `unsafe entrypoint: ${plan.entrypoint}`;
  }
  if (plan.imagePathEnvVar && !SAFE_ENV_VAR.test(plan.imagePathEnvVar)) {
    return `unsafe image env var: ${plan.imagePathEnvVar}`;
  }
  if (plan.installDir !== undefined) {
    const dir = plan.installDir;
    if (
      !dir.startsWith("/") ||
      dir === "/" ||
      dir.endsWith("/") ||
      dir.includes("..") ||
      dir.includes("~") ||
      dir.includes("'") ||
      /[\x00-\x1f\x7f\s]/u.test(dir)
    ) {
      return `unsafe install dir: ${dir}`;
    }
  }
  return null;
}

/**
 * The verify → unpack → promote tail shared by the fetch and upload rungs:
 * the archive is already at `<staging>/asset.zip`; digest-check it, unpack,
 * mark executables, and atomically promote the staging directory. The stamp
 * is deliberately NOT written here — the caller uploads it as the final act,
 * so an interrupted promotion is restaged rather than trusted.
 */
function unpackAndPromoteCommand(input: {
  plan: RuntimeAssetPlan;
  stagingDir: string;
  assetDir: string;
}): string {
  const { plan } = input;
  const executables = [plan.entrypoint, ...(plan.makeExecutable ?? [])];
  return [
    "set -e",
    `cd ${shellQuoteSingle(input.stagingDir)}`,
    `echo ${shellQuoteSingle(`${plan.sha256}  asset.zip`)} | sha256sum -c - >/dev/null`,
    "unzip -q asset.zip",
    "rm -f asset.zip",
    ...executables.map(
      (relativePath) => `chmod +x ${shellQuoteSingle(relativePath)} || true`,
    ),
    `rm -rf ${shellQuoteSingle(input.assetDir)}`,
    `mv ${shellQuoteSingle(input.stagingDir)} ${shellQuoteSingle(input.assetDir)}`,
  ].join(" && ");
}

async function hasValidStamp(input: {
  session: RuntimeAssetSessionLike;
  plan: RuntimeAssetPlan;
  assetDir: string;
}): Promise<boolean> {
  const [stamp] = await input.session.downloadFiles([
    `${input.assetDir}/${STAMP_FILE}`,
  ]);
  if (!stamp?.content || stamp.error) {
    return false;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(stamp.content)) as {
      version?: string;
      sha256?: string;
    };
    return (
      parsed.version === input.plan.version &&
      parsed.sha256 === input.plan.sha256
    );
  } catch {
    return false;
  }
}

async function writeStamp(input: {
  session: RuntimeAssetSessionLike;
  plan: RuntimeAssetPlan;
  assetDir: string;
  rung: "fetch" | "upload";
}): Promise<boolean> {
  const [result] = await input.session.uploadFiles([
    [
      `${input.assetDir}/${STAMP_FILE}`,
      new TextEncoder().encode(
        JSON.stringify(assetStamp(input.plan, input.rung), null, 2),
      ),
    ],
  ]);
  return Boolean(result) && !result!.error;
}

/**
 * Resolve one asset through the universal rungs. Returns a resolution rather
 * than throwing: staging is best-effort by contract and the *caller* decides
 * whether a missing asset is fatal (it usually degrades to the asset's native
 * fallback, e.g. Remotion's own browser download).
 */
async function ensureRuntimeAsset(input: {
  session: RuntimeAssetSessionLike;
  plan: RuntimeAssetPlan;
  logger?: RuntimeAssetLogger;
  toolCallKey?: string;
}): Promise<RuntimeAssetResolution> {
  const startedAt = Date.now();
  const { plan, session } = input;
  const base = { name: plan.name, version: plan.version };
  const invalid = validatePlan(plan);
  if (invalid) {
    return { ...base, ok: false, ms: Date.now() - startedAt, error: invalid };
  }

  const rootDir = session.rootDir.replace(/\/$/u, "");
  const assetDir =
    plan.installDir ?? `${rootDir}/${ASSETS_DIR}/${plan.name}/${plan.version}`;
  const stagingDir = `${assetDir}.staging`;
  const entrypointPath = `${assetDir}/${plan.entrypoint}`;
  const execute = (command: string, label: string) =>
    session.execute(command, {
      ...(input.toolCallKey
        ? { toolCallId: `${input.toolCallKey}:asset-${plan.name}-${label}` }
        : {}),
    });

  // Rung: image — the sandbox image baked the asset and points at it via env.
  // Probed inside the sandbox (not trusted from config): the env must exist
  // AND be an executable path, or the ladder proceeds as if unset.
  if (plan.imagePathEnvVar) {
    const probe = await execute(
      `test -x "$${plan.imagePathEnvVar}" && printf '%s' "$${plan.imagePathEnvVar}"`,
      "image-probe",
    );
    const probedPath = probe.output.trim();
    if (probe.exitCode === 0 && probedPath.startsWith("/")) {
      return {
        ...base,
        ok: true,
        rung: "image",
        entrypointPath: probedPath,
        ms: Date.now() - startedAt,
      };
    }
  }

  // Rung: stamp — already staged in this sandbox.
  if (await hasValidStamp({ session, plan, assetDir })) {
    return {
      ...base,
      ok: true,
      rung: "stamp",
      entrypointPath,
      ms: Date.now() - startedAt,
    };
  }

  const errors: string[] = [];

  // Rung: fetch — in-sandbox download from the platform cache.
  if (plan.fetchUrl) {
    try {
      const url = await plan.fetchUrl();
      if (url) {
        if (url.includes("'")) {
          throw new Error("presigned URL contains a single quote");
        }
        const command = [
          "set -e",
          `rm -rf ${shellQuoteSingle(stagingDir)}`,
          `mkdir -p ${shellQuoteSingle(stagingDir)}`,
          `curl -fsSL --retry 4 --retry-all-errors --connect-timeout 15 -o ${shellQuoteSingle(`${stagingDir}/asset.zip`)} ${shellQuoteSingle(url)}`,
          unpackAndPromoteCommand({ plan, stagingDir, assetDir }),
        ].join(" && ");
        const result = await execute(command, "fetch");
        if (result.exitCode === 0) {
          if (await writeStamp({ session, plan, assetDir, rung: "fetch" })) {
            return {
              ...base,
              ok: true,
              rung: "fetch",
              entrypointPath,
              ms: Date.now() - startedAt,
            };
          }
          errors.push("fetch: staged but stamp write failed");
        } else {
          errors.push(
            `fetch: exit ${result.exitCode}: ${result.output.slice(-400)}`,
          );
        }
      } else {
        errors.push("fetch: platform cache returned no URL");
      }
    } catch (error) {
      errors.push(
        `fetch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    input.logger?.warn?.("sandbox_runtime_asset_rung_failed", {
      asset: plan.name,
      rung: "fetch",
      error: errors.at(-1),
    });
  }

  // Rung: upload — push the archive through the session API. Slow, but it is
  // the one transport every provider has, including zero-egress sandboxes.
  if (plan.loadContent) {
    try {
      const content = await plan.loadContent();
      if (content && content.byteLength > 0) {
        const prepare = await execute(
          [
            "set -e",
            `rm -rf ${shellQuoteSingle(stagingDir)}`,
            `mkdir -p ${shellQuoteSingle(stagingDir)}`,
          ].join(" && "),
          "upload-prepare",
        );
        if (prepare.exitCode !== 0) {
          throw new Error(`staging mkdir failed: ${prepare.output.slice(-200)}`);
        }
        const [uploaded] = await session.uploadFiles([
          [`${stagingDir}/asset.zip`, content],
        ]);
        if (uploaded?.error) {
          throw new Error(`upload failed: ${uploaded.error}`);
        }
        const result = await execute(
          unpackAndPromoteCommand({ plan, stagingDir, assetDir }),
          "upload-unpack",
        );
        if (result.exitCode === 0) {
          if (await writeStamp({ session, plan, assetDir, rung: "upload" })) {
            return {
              ...base,
              ok: true,
              rung: "upload",
              entrypointPath,
              ms: Date.now() - startedAt,
              bytes: content.byteLength,
            };
          }
          errors.push("upload: staged but stamp write failed");
        } else {
          errors.push(
            `upload: exit ${result.exitCode}: ${result.output.slice(-400)}`,
          );
        }
      } else {
        errors.push("upload: platform cache returned no content");
      }
    } catch (error) {
      errors.push(
        `upload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    input.logger?.warn?.("sandbox_runtime_asset_rung_failed", {
      asset: plan.name,
      rung: "upload",
      error: errors.at(-1),
    });
  }

  return {
    ...base,
    ok: false,
    ms: Date.now() - startedAt,
    error: errors.join(" | ") || "no staging rung available",
  };
}

/** Resolve assets sequentially; per-asset outcomes, never a throw. */
export async function ensureRuntimeAssets(input: {
  session: RuntimeAssetSessionLike;
  assets: readonly RuntimeAssetPlan[];
  logger?: RuntimeAssetLogger;
  /** Prefix for per-command toolCallIds (collision safety across retries). */
  toolCallKey?: string;
}): Promise<RuntimeAssetResolution[]> {
  const resolutions: RuntimeAssetResolution[] = [];
  for (const plan of input.assets) {
    resolutions.push(
      await ensureRuntimeAsset({
        session: input.session,
        plan,
        logger: input.logger,
        ...(input.toolCallKey ? { toolCallKey: input.toolCallKey } : {}),
      }),
    );
  }
  return resolutions;
}
