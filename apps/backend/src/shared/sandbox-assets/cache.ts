import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, sandboxAssetCache } from "@sourceweft/db";
import {
  buildSandboxAssetStorageKey,
  downloadSandboxAssetObject,
  getContentStorageBucketName,
  getSandboxAssetDownloadUrl,
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
 * Concurrency is deliberately unguarded: two workers racing the first miss
 * both download and both write the same immutable bytes to the same key —
 * wasteful once, never wrong. A lock table would guard a ~once-per-version
 * event.
 */

const UPSTREAM_ATTEMPTS_PER_URL = 3;

type CacheRow = {
  status: string;
  storageBucket: string | null;
  storageKey: string | null;
};

async function findRow(spec: SandboxAssetSpec): Promise<CacheRow | undefined> {
  const [row] = await db
    .select({
      status: sandboxAssetCache.status,
      storageBucket: sandboxAssetCache.storageBucket,
      storageKey: sandboxAssetCache.storageKey,
    })
    .from(sandboxAssetCache)
    .where(
      and(
        eq(sandboxAssetCache.name, spec.name),
        eq(sandboxAssetCache.version, spec.version),
        eq(sandboxAssetCache.platform, spec.platform),
      ),
    )
    .limit(1);
  return row;
}

async function upsertRow(
  spec: SandboxAssetSpec,
  values: {
    status: "pending" | "ready" | "failed";
    storageBucket?: string | null;
    storageKey?: string | null;
    sizeBytes?: number | null;
    error?: string | null;
  },
) {
  await db
    .insert(sandboxAssetCache)
    .values({
      name: spec.name,
      version: spec.version,
      platform: spec.platform,
      sha256: spec.sha256,
      status: values.status,
      storageBucket: values.storageBucket ?? null,
      storageKey: values.storageKey ?? null,
      sizeBytes: values.sizeBytes ?? null,
      error: values.error ?? null,
    })
    .onConflictDoUpdate({
      target: [
        sandboxAssetCache.name,
        sandboxAssetCache.version,
        sandboxAssetCache.platform,
      ],
      set: {
        status: values.status,
        storageBucket: values.storageBucket ?? null,
        storageKey: values.storageKey ?? null,
        sizeBytes: values.sizeBytes ?? null,
        error: values.error ?? null,
        updatedAt: sql`now()`,
      },
    });
}

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
 * Idempotent mirror: resolves to the cached object's location, downloading
 * and verifying from upstream only when no ready copy exists. A previously
 * `failed` row is retried — failure states are diagnostic, never sticky.
 */
export async function ensureSandboxAssetCached(
  spec: SandboxAssetSpec,
): Promise<{ bucket: string; key: string }> {
  const existing = await findRow(spec);
  if (existing?.status === "ready" && existing.storageKey) {
    return {
      bucket: existing.storageBucket ?? getContentStorageBucketName(),
      key: existing.storageKey,
    };
  }

  await upsertRow(spec, { status: "pending" });
  try {
    const bytes = await downloadUpstream(spec);
    const key = buildSandboxAssetStorageKey(spec);
    await uploadSandboxAssetObject({ key, body: bytes });
    const bucket = getContentStorageBucketName();
    await upsertRow(spec, {
      status: "ready",
      storageBucket: bucket,
      storageKey: key,
      sizeBytes: bytes.byteLength,
    });
    logger.info("sandbox_asset_cached", {
      name: spec.name,
      version: spec.version,
      platform: spec.platform,
      sizeBytes: bytes.byteLength,
    });
    return { bucket, key };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertRow(spec, { status: "failed", error: message.slice(0, 500) });
    logger.warn("sandbox_asset_cache_failed", {
      name: spec.name,
      version: spec.version,
      error: message,
    });
    throw error;
  }
}

/** Presigned URL for the fetch rung. */
export async function presignSandboxAssetUrl(
  spec: SandboxAssetSpec,
): Promise<string> {
  const location = await ensureSandboxAssetCached(spec);
  return getSandboxAssetDownloadUrl({
    bucket: location.bucket,
    key: location.key,
  });
}

/** Whole-archive bytes for the upload rung (universal fallback transport). */
export async function loadSandboxAssetContent(
  spec: SandboxAssetSpec,
): Promise<Uint8Array> {
  const location = await ensureSandboxAssetCached(spec);
  return downloadSandboxAssetObject({
    bucket: location.bucket,
    key: location.key,
  });
}
