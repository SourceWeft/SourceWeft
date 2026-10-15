import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { sandboxVolumeAttachments } from "@sourceweft/db/schema";
import { sandboxVolumeService } from "../../modules/threads/agent/sandbox-service/volume";
import { logger } from "../../shared/logger";

let cursor: string | undefined;

/** Apply background daemon commits even when no command completes on this backend.
 * Database fencing keeps multiple schedulers safe; this cursor bounds and fairly
 * rotates the work. Object deletion is deliberately a separate explicit GC action.
 */
export async function scheduleSandboxVolumeWal() {
  const service = sandboxVolumeService();
  if (!service) return { checked: 0, applied: 0, failed: 0 };
  const actors = await db
    .select({ id: sandboxVolumeAttachments.id })
    .from(sandboxVolumeAttachments)
    .where(
      and(
        eq(sandboxVolumeAttachments.status, "active"),
        cursor ? gt(sandboxVolumeAttachments.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(sandboxVolumeAttachments.id))
    .limit(40);
  cursor = actors.length === 40 ? actors[actors.length - 1]!.id : undefined;
  const result = { checked: actors.length, applied: 0, failed: 0 };
  for (let offset = 0; offset < actors.length; offset += 4) {
    await Promise.all(
      actors.slice(offset, offset + 4).map(async (actor) => {
        try {
          const wal = await service.applyWal(actor.id, { maxCommits: 16 });
          result.applied += wal.applied;
          if (wal.rejected) {
            result.failed++;
            logger.error("sandbox.volume.background_wal_rejected", {
              attachmentId: actor.id,
            });
          }
        } catch (error) {
          result.failed++;
          // Network errors may embed signed URLs. Log a classification, never their raw text.
          logger.error("sandbox.volume.background_wal_failed", {
            attachmentId: actor.id,
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
      }),
    );
  }
  if (result.checked) logger.info("sandbox.volume.background_wal", result);
  if (result.failed)
    throw new Error(
      `Sandbox volume WAL maintenance failed for ${result.failed} of ${result.checked} attachments`,
    );
  return result;
}
