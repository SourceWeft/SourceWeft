import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SandboxVolumeHooks } from "@sourceweft/builtin-tool-sandbox";
import { db } from "@sourceweft/db";
import {
  createS3ObjectStore,
  VolumeService,
  type ObjectStore,
} from "@sourceweft/sandbox-volume";
import { createVolumeHooks } from "@sourceweft/sandbox-volume/hooks";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";

/**
 * Persistent /workspace volume wiring. One service per process; hooks are handed to the sandbox
 * runtime when `SOURCEWEFT_SANDBOX_VOLUME_ENABLED` is on. Nothing here is reachable from a sandbox
 * except pre-signed URLs produced by the service.
 */
let cached: { hooks: SandboxVolumeHooks; service: VolumeService } | null = null;
let helperUpload: Promise<string> | null = null;

function objectStore(): ObjectStore {
  const s3 = config.s3;
  if (!s3.bucket) throw new Error("SOURCEWEFT_SANDBOX_VOLUME_ENABLED requires S3_BUCKET");
  return createS3ObjectStore({
    bucket: s3.bucket,
    region: s3.region,
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle,
    ...(s3.accessKeyId && s3.secretAccessKey
      ? { credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } }
      : {}),
  });
}

/** Upload the helper binary once per process (content-addressed key) and return its bucket key. */
function helperKey(store: ObjectStore, keyPrefix: string): Promise<string> {
  helperUpload ??= (async () => {
    const path = config.sandbox.volume.helperPath;
    if (!path) throw new Error("SOURCEWEFT_SANDBOX_VOLUME_HELPER_PATH or SOURCEWEFT_SANDBOX_VOLUME_HELPER_IMAGE_PATH is required");
    const body = readFileSync(path);
    const key = `${keyPrefix}bin/swvol-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
    if ((await store.size(key)) === null) {
      await store.put(key, body);
      logger.info("sandbox.volume.helper_uploaded", { key, bytes: body.length });
    }
    return key;
  })();
  return helperUpload;
}

export function sandboxVolumeHooks(): SandboxVolumeHooks | null {
  const settings = config.sandbox.volume;
  if (!settings.enabled) return null;
  if (!cached) {
    const store = objectStore();
    const service = new VolumeService({ db, store, keyPrefix: settings.keyPrefix });
    const hooks = createVolumeHooks({
      service,
      shadow: settings.mode === "shadow",
      helper: settings.helperImagePath
        ? { imagePath: settings.helperImagePath }
        : { downloadUrl: async () => store.presignGet(await helperKey(store, settings.keyPrefix), 3600) },
      log: (event, fields) => logger.info(`sandbox.volume.${event.replace(/^volume\./, "")}`, fields),
    });
    cached = { hooks, service };
  }
  return cached.hooks;
}

export function sandboxVolumeService(): VolumeService | null {
  return sandboxVolumeHooks() ? cached!.service : null;
}
