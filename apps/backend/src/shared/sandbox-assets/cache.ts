import { createHash } from "node:crypto";
import {
  buildSandboxAssetStorageKey,
  downloadSandboxAssetObject,
  getSandboxAssetDownloadUrl,
  sandboxAssetObjectExists,
  uploadSandboxAssetObject,
} from "../../modules/sources/storage";
import { logger } from "../logger";
import type { SandboxAssetSpec } from "./catalog";

/**
 * Platform cache for sandbox runtime assets — the only upstream-facing
 * component of the ladder (docs/architecture/sandbox-runtime-assets.md, A7).
 * `ensureSandboxAssetCached` mirrors an asset's archive from its upstream
 * into our object storage exactly once (sha256-verified before a byte is
 * stored); everything downstream consumes our copy.
 *
 * Deliberately stateless: the storage key embeds the digest, and uploads only
 * follow full verification, so *object existence is the cache index* — no
 * database table (image-first review, 2026-08-05: one less moving part for a
 * path that the baked image makes nearly dormant). Failure diagnostics live
 * in logs; concurrency is unguarded because two racers write identical bytes
 * to an identical key — wasteful once, never wrong.
 */

const UPSTREAM_ATTEMPTS_PER_URL = 3;

async function downloadUpstream(spec: SandboxAssetSpec): Promise<Uint8Array> {
  const failures: string[] = [];
  for (const url of spec.upstreamUrls) {
    for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS_PER_URL; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`upstream responded ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== spec.sha256) {
          // A digest mismatch is not transient — do not retry this URL.
          failures.push(`${url}: sha256 mismatch (got ${digest})`);
          break;
        }
        return bytes;
      } catch (error) {
        failures.push(
          `${url} (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  throw new Error(`all upstreams failed: ${failures.join(" | ")}`);
}

/**
 * Idempotent mirror: resolves to the cached object's key, downloading and
 * verifying from upstream only when the digest-addressed key does not exist.
 */
export async function ensureSandboxAssetCached(
  spec: SandboxAssetSpec,
): Promise<{ key: string }> {
  const key = buildSandboxAssetStorageKey(spec);
  if (await sandboxAssetObjectExists({ key })) {
    return { key };
  }

  try {
    const bytes = await downloadUpstream(spec);
    await uploadSandboxAssetObject({ key, body: bytes });
    logger.info("sandbox_asset_cached", {
      name: spec.name,
      version: spec.version,
      platform: spec.platform,
      sizeBytes: bytes.byteLength,
    });
    return { key };
  } catch (error) {
    logger.warn("sandbox_asset_cache_failed", {
      name: spec.name,
      version: spec.version,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Presigned URL for the fetch rung. */
export async function presignSandboxAssetUrl(
  spec: SandboxAssetSpec,
): Promise<string> {
  const { key } = await ensureSandboxAssetCached(spec);
  return getSandboxAssetDownloadUrl({ key });
}

/** Whole-archive bytes for the upload rung (universal fallback transport). */
export async function loadSandboxAssetContent(
  spec: SandboxAssetSpec,
): Promise<Uint8Array> {
  const { key } = await ensureSandboxAssetCached(spec);
  return downloadSandboxAssetObject({ key });
}
