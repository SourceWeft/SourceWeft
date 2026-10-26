import type { ArtifactRecordScope } from "@sourceweft/contracts/artifact-records";
import { HTML_ARTIFACT_TYPE } from "@sourceweft/contracts/html-artifact";
import { logger } from "../../shared/logger";
import { findArtifactRecord } from "../artifacts/repository";
import { teamAuditService } from "../team-audit";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import {
  clearRecords,
  listRecordPage,
  type ExportCursor,
} from "./export-repository";
import { redisRecordRateLimiter, type RecordRateLimiter } from "./rate-limit";
import type { RecordPartition } from "./repository";
import { artifactRecordError } from "./service";

/** Rows fetched per keyset page; it bounds how much one export holds in memory. */
export const EXPORT_PAGE_SIZE = 500;

/** Fixed one-second windows, per viewer and artifact; an export is a full scan. */
const EXPORTS_PER_SECOND = 2;
const CLEARS_PER_SECOND = 5;

export const EXPORT_FORMAT = "sourceweft.artifact-records";

export type ArtifactRecordsDataInput = {
  workspaceId: string;
  artifactId: string;
  userId: string;
  scope: ArtifactRecordScope;
  /** Narrows the operation to one collection. */
  collection?: string;
};

type Authorized = {
  teamId: string;
  artifactId: string;
  partition: RecordPartition;
};

export type ArtifactRecordsExport = {
  filename: string;
  stream: ReadableStream<Uint8Array>;
};

/**
 * Export and clear for the people who own page data.
 *
 * Data belongs to the artifact, so neither operation looks at a version or at
 * the shared-storage approval: those gate what a *page* may do, not what a
 * person may do with their own data (or with the data of an artifact they
 * created). The partition is derived from the session exactly as the page
 * bridge derives it, which is what keeps one member out of another's `user`
 * records: there is no input that names an owner.
 */
export class ArtifactRecordsExportService {
  constructor(
    private readonly rateLimiter: RecordRateLimiter = redisRecordRateLimiter,
    private readonly pageSize = EXPORT_PAGE_SIZE,
  ) {}

  private async limit(key: string, limit: number) {
    let allowed: boolean;
    try {
      allowed = await this.rateLimiter.allow(key, limit);
    } catch (error) {
      logger.error("artifact_record_rate_limit_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw artifactRecordError(
        "unavailable",
        "Storage is temporarily unavailable",
      );
    }
    if (!allowed)
      throw artifactRecordError("rate_limited", "Too many requests; slow down");
  }

  /**
   * `user` data is reachable by any member who can open the artifact, and only
   * ever their own. `shared` data needs the rule publishing a link needs: the
   * artifact's creator or a content admin.
   */
  private async authorize(
    input: ArtifactRecordsDataInput,
  ): Promise<Authorized> {
    // Missing, private and wrong-type artifacts look alike to the caller.
    const unavailable = () =>
      artifactRecordError(
        "unavailable",
        "Storage is not available for this artifact",
      );
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || access.role === null) throw unavailable();
    const artifact = await findArtifactRecord({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    });
    if (
      !artifact ||
      artifact.artifactType !== HTML_ARTIFACT_TYPE ||
      !canViewContent(input.userId, artifact)
    )
      throw unavailable();
    if (
      input.scope === "shared" &&
      artifact.createdBy !== input.userId &&
      !workspaceService.canAdministerContent(access)
    )
      throw artifactRecordError(
        "forbidden",
        "Only the artifact's creator or a workspace admin can manage shared data",
      );
    return {
      teamId: access.organizationId,
      artifactId: artifact.id,
      partition: {
        artifactId: artifact.id,
        scope: input.scope,
        ownerUserId: input.scope === "user" ? input.userId : null,
      },
    };
  }

  /**
   * Authorizes, then returns a stream that is one valid JSON document. Rows
   * are read a keyset page at a time as the client drains the stream, so the
   * size of the data never decides how much memory the export takes. A failure
   * part way errors the stream, which the client sees as a truncated (invalid)
   * document rather than a complete-looking one that is missing rows. Pages
   * are not one snapshot: a record written during the export may or may not
   * be in it.
   */
  async export(
    input: ArtifactRecordsDataInput,
  ): Promise<ArtifactRecordsExport> {
    await this.limit(
      `${input.userId}:${input.artifactId}:export`,
      EXPORTS_PER_SECOND,
    );
    const context = await this.authorize(input);
    const exportedAt = new Date().toISOString();
    const pageSize = this.pageSize;
    const encoder = new TextEncoder();
    const audit = (records: number, complete: boolean) =>
      teamAuditService.record({
        teamId: context.teamId,
        actorUserId: input.userId,
        action: "artifact.records_exported",
        targetType: "artifact",
        targetId: context.artifactId,
        // Counts and names only: the data itself is never written to the log.
        metadata: {
          scope: input.scope,
          ...(input.collection ? { collection: input.collection } : {}),
          records,
          complete,
        },
      });

    let after: ExportCursor | null = null;
    let started = false;
    let finished = false;
    let written = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          let chunk = "";
          if (!started) {
            started = true;
            chunk = `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":1,"artifactId":${JSON.stringify(context.artifactId)},"scope":${JSON.stringify(input.scope)},${
              input.collection
                ? `"collection":${JSON.stringify(input.collection)},`
                : ""
            }"exportedAt":${JSON.stringify(exportedAt)},"records":[`;
          }
          const rows = await listRecordPage({
            partition: context.partition,
            collection: input.collection,
            after,
            limit: pageSize,
          });
          for (const row of rows) {
            chunk += `${written ? "," : ""}${JSON.stringify({
              scope: input.scope,
              collection: row.collection,
              id: row.id,
              data: row.data,
              etag: row.etag,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            })}`;
            written += 1;
          }
          const last = rows.at(-1);
          if (last) after = { collection: last.collection, id: last.id };
          if (rows.length < pageSize) {
            chunk += "]}";
            finished = true;
          }
          controller.enqueue(encoder.encode(chunk));
          if (finished) {
            // Audit before closing, so a client that has the whole document
            // can rely on the entry existing. `record` never throws.
            await audit(written, true);
            controller.close();
          }
        } catch (error) {
          logger.error("artifact_record_export_failed", {
            artifactId: context.artifactId,
            error: error instanceof Error ? error.message : String(error),
          });
          await audit(written, false);
          controller.error(error);
        }
      },
      cancel: async () => {
        if (!finished) await audit(written, false);
      },
    });

    const parts = [
      context.artifactId,
      input.scope,
      ...(input.collection ? [input.collection] : []),
      "records",
    ];
    return { filename: `${parts.join("-")}.json`, stream };
  }

  /** Authorizes, deletes the slice, audits the count, and returns it. */
  async clear(input: ArtifactRecordsDataInput): Promise<{ removed: number }> {
    await this.limit(
      `${input.userId}:${input.artifactId}:clear`,
      CLEARS_PER_SECOND,
    );
    const context = await this.authorize(input);
    const removed = await clearRecords({
      partition: context.partition,
      collection: input.collection,
    });
    await teamAuditService.record({
      teamId: context.teamId,
      actorUserId: input.userId,
      action: "artifact.records_cleared",
      targetType: "artifact",
      targetId: context.artifactId,
      metadata: {
        scope: input.scope,
        ...(input.collection ? { collection: input.collection } : {}),
        removed,
      },
    });
    return { removed };
  }
}

export const artifactRecordsExportService = new ArtifactRecordsExportService();
