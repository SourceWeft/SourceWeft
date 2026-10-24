import {
  ARTIFACT_RECORD_LIMITS,
  artifactRecordApiErrorCode,
  artifactRecordIdSchema,
  checkArtifactRecordData,
  type ArtifactRecordErrorCode,
  type ArtifactRecordFilter,
  type ArtifactRecordOperation,
  type ArtifactRecordResult,
  type ArtifactRecordScope,
} from "@sourceweft/contracts/artifact-records";
import {
  HTML_ARTIFACT_TYPE,
  htmlArtifactRecordCapabilities,
} from "@sourceweft/contracts/html-artifact";
import { logger } from "../../shared/logger";
import { ContentError } from "../content/errors";
import {
  findArtifactRecord,
  findCurrentReadyArtifactVersionRecord,
  findReadyArtifactVersionRecord,
} from "../artifacts/repository";
import { findLiveShareByToken } from "../sharing/store";
import { teamAuditService } from "../team-audit";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import {
  workspaceRoleSatisfies,
  type WorkspaceAccess,
} from "../workspace/types";
import {
  decodeQueryCursor,
  encodeQueryCursor,
  queryFingerprint,
} from "./query";
import { redisRecordRateLimiter, type RecordRateLimiter } from "./rate-limit";
import {
  approveShared,
  deleteRecord,
  deleteUserRecordData,
  findActiveSharedApproval,
  findUserNames,
  findVersionAuthor,
  grantSharedConsent,
  hasSharedConsent,
  queryRecords,
  readRecord,
  RecordQueryTimeoutError,
  revokeShared,
  writeRecord,
  type RecordPartition,
} from "./repository";

const ERROR_STATUS: Record<ArtifactRecordErrorCode, number> = {
  unavailable: 404,
  forbidden: 403,
  consent_required: 403,
  not_found: 404,
  conflict: 409,
  quota_exceeded: 413,
  rate_limited: 429,
  query_too_expensive: 422,
  invalid_request: 400,
};

export function artifactRecordError(
  code: ArtifactRecordErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return new ContentError(
    ERROR_STATUS[code],
    artifactRecordApiErrorCode(code),
    message,
    details ? { details } : {},
  );
}

/** Missing, private and wrong-type artifacts look alike to the caller. */
const unavailable = () =>
  artifactRecordError(
    "unavailable",
    "Storage is not available for this artifact",
  );

type VersionContext = {
  access: WorkspaceAccess & { role: NonNullable<WorkspaceAccess["role"]> };
  teamId: string;
  workspaceId: string;
  artifactId: string;
  versionId: string;
  artifactCreatedBy: string | null;
  capabilities: { storage: boolean; shared: boolean };
};

function isWrite(operation: ArtifactRecordOperation) {
  return operation.op === "set" || operation.op === "delete";
}

/** Filter values become `jsonb` parameters, so they obey the stored-value rules. */
function filterValueProblem(filter: ArtifactRecordFilter): string | null {
  if (filter.op === "exists") return null;
  if (filter.value === undefined)
    return `Filter on ${filter.path} needs a value`;
  const check = checkArtifactRecordData(filter.value);
  return check.ok ? null : check.reason;
}

/**
 * The single authorization and execution path for artifact page storage.
 *
 * Identity, workspace, artifact and version all come from the host; the page
 * contributes only the operation. Every request re-resolves access, so a
 * removed member or a revoked approval stops the very next call.
 */
export class ArtifactRecordsService {
  constructor(
    private readonly rateLimiter: RecordRateLimiter = redisRecordRateLimiter,
  ) {}

  private async loadVersion(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }): Promise<VersionContext> {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || access.role === null) throw unavailable();
    const version = await findReadyArtifactVersionRecord({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      artifactVersionId: input.versionId,
    });
    if (
      !version ||
      version.artifactType !== HTML_ARTIFACT_TYPE ||
      !canViewContent(input.userId, version)
    )
      throw unavailable();
    return {
      access: access as VersionContext["access"],
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: version.id,
      versionId: version.versionId,
      artifactCreatedBy: version.createdBy,
      capabilities: htmlArtifactRecordCapabilities(version.contentJson),
    };
  }

  private async limit(key: string, write: boolean) {
    let allowed: boolean;
    try {
      allowed = await this.rateLimiter.allow(
        `${key}:${write ? "w" : "r"}`,
        write
          ? ARTIFACT_RECORD_LIMITS.writesPerSecond
          : ARTIFACT_RECORD_LIMITS.readsPerSecond,
      );
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
      throw artifactRecordError(
        "rate_limited",
        "Too many storage requests; slow down",
      );
  }

  async execute(input: {
    workspaceId: string;
    artifactId: string;
    userId: string;
    versionId: string;
    operation: ArtifactRecordOperation;
  }): Promise<ArtifactRecordResult> {
    const context = await this.loadVersion(input);
    const { operation } = input;
    if (!context.capabilities.storage)
      throw artifactRecordError(
        "forbidden",
        "This version does not declare storage",
      );
    if (operation.scope === "shared") {
      if (!context.capabilities.shared)
        throw artifactRecordError(
          "forbidden",
          "This version does not declare shared storage",
        );
      if (!(await findActiveSharedApproval(context.versionId)))
        throw artifactRecordError(
          "forbidden",
          "Shared data access for this version has not been approved",
          { reason: "capability_not_approved" },
        );
      if (
        !(await hasSharedConsent({
          userId: input.userId,
          versionId: context.versionId,
        }))
      )
        throw artifactRecordError(
          "consent_required",
          "Allow this page to use shared data first",
        );
      if (
        isWrite(operation) &&
        !workspaceRoleSatisfies(context.access.role, "editor")
      )
        throw artifactRecordError(
          "forbidden",
          "Your role in this workspace is read-only",
        );
    }
    await this.limit(
      `${input.userId}:${context.artifactId}`,
      isWrite(operation),
    );

    const partition: RecordPartition = {
      artifactId: context.artifactId,
      scope: operation.scope,
      ownerUserId: operation.scope === "user" ? input.userId : null,
    };
    return this.run({
      operation,
      partition,
      teamId: context.teamId,
      workspaceId: context.workspaceId,
      actorUserId: input.userId,
      versionId: context.versionId,
    });
  }

  private async run(input: {
    operation: ArtifactRecordOperation;
    partition: RecordPartition;
    teamId: string;
    workspaceId: string;
    actorUserId: string;
    versionId: string;
  }): Promise<ArtifactRecordResult> {
    const { operation, partition } = input;
    switch (operation.op) {
      case "get":
        return {
          op: "get",
          record: await readRecord({
            ...partition,
            collection: operation.collection,
            recordId: operation.id,
          }),
        };
      case "set": {
        const check = checkArtifactRecordData(operation.data);
        if (!check.ok)
          throw artifactRecordError("invalid_request", check.reason);
        const result = await writeRecord({
          key: {
            ...partition,
            collection: operation.collection,
            recordId: operation.id,
          },
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          data: operation.data,
          sizeBytes: check.sizeBytes,
          ifMatch: operation.ifMatch,
          limits: limitsFor(partition.scope),
        });
        this.audit(
          "set",
          input,
          operation.collection,
          operation.id,
          result.kind,
          check.sizeBytes,
        );
        if (result.kind === "conflict")
          throw artifactRecordError(
            "conflict",
            "The record changed; read it again",
          );
        if (result.kind === "quota_exceeded")
          throw artifactRecordError("quota_exceeded", result.reason);
        return { op: "set", etag: result.etag, updatedAt: result.updatedAt };
      }
      case "delete": {
        const result = await deleteRecord({
          key: {
            ...partition,
            collection: operation.collection,
            recordId: operation.id,
          },
          ifMatch: operation.ifMatch,
        });
        this.audit(
          "delete",
          input,
          operation.collection,
          operation.id,
          result.kind,
          0,
        );
        if (result.kind === "conflict")
          throw artifactRecordError(
            "conflict",
            "The record changed; read it again",
          );
        return { op: "delete", deleted: result.kind === "deleted" };
      }
      case "query":
        return this.query(partition, operation);
    }
  }

  private async query(
    partition: RecordPartition,
    operation: Extract<ArtifactRecordOperation, { op: "query" }>,
  ): Promise<ArtifactRecordResult> {
    for (const filter of operation.where) {
      const problem = filterValueProblem(filter);
      if (problem) throw artifactRecordError("invalid_request", problem);
    }
    const fingerprint = queryFingerprint({
      scope: partition.scope,
      collection: operation.collection,
      where: operation.where,
      orderBy: operation.orderBy,
      idPrefix: operation.idPrefix,
    });
    const cursor = operation.cursor
      ? decodeQueryCursor(operation.cursor, {
          fingerprint,
          sortKeyCount: operation.orderBy.length,
        })
      : null;
    // A cursor is page-held text: its values are bound as `jsonb` and its id
    // as a record id, so a forged one must pass the same checks as input.
    if (
      operation.cursor &&
      (!cursor ||
        !artifactRecordIdSchema.safeParse(cursor.id).success ||
        !checkArtifactRecordData(cursor.values).ok)
    )
      throw artifactRecordError(
        "invalid_request",
        "The cursor does not belong to this query",
      );

    let rows;
    try {
      rows = await queryRecords({
        partition,
        collection: operation.collection,
        where: operation.where,
        orderBy: operation.orderBy,
        idPrefix: operation.idPrefix,
        cursor,
        fetch: operation.limit + 1,
        timeoutMs: ARTIFACT_RECORD_LIMITS.queryTimeoutMs,
      });
    } catch (error) {
      if (error instanceof RecordQueryTimeoutError)
        throw artifactRecordError(
          "query_too_expensive",
          "The query took too long; narrow it with filters",
        );
      throw error;
    }

    const page = [];
    let bytes = 0;
    for (const row of rows.slice(0, operation.limit)) {
      if (
        page.length &&
        bytes + row.sizeBytes > ARTIFACT_RECORD_LIMITS.queryResponseBytes
      )
        break;
      bytes += row.sizeBytes;
      page.push(row);
    }
    const hasMore = page.length < rows.length;
    const last = page.at(-1);
    return {
      op: "query",
      records: page.map(
        ({ sizeBytes: _size, sortValues: _sort, ...record }) => record,
      ),
      cursor:
        hasMore && last
          ? encodeQueryCursor({
              fingerprint,
              values: last.sortValues,
              id: last.id,
            })
          : null,
    };
  }

  private audit(
    op: "set" | "delete",
    input: {
      partition: RecordPartition;
      actorUserId: string;
      versionId: string;
      teamId: string;
    },
    collection: string,
    recordId: string,
    outcome: string,
    sizeBytes: number,
  ) {
    // Values are never logged: they are page data, possibly personal.
    logger.info("artifact_record_write", {
      op,
      outcome,
      teamId: input.teamId,
      artifactId: input.partition.artifactId,
      versionId: input.versionId,
      scope: input.partition.scope,
      collection,
      recordId,
      sizeBytes,
      actorUserId: input.actorUserId,
    });
  }

  /** Read-only access for a public share page; the share token is the only grant. */
  async executePublic(input: {
    token: string;
    clientKey: string;
    operation: ArtifactRecordOperation;
  }): Promise<ArtifactRecordResult> {
    const share = await findLiveShareByToken(input.token);
    if (
      !share ||
      share.targetType !== "artifact" ||
      !share.isPublic ||
      !share.workspaceId
    )
      throw unavailable();
    const { operation } = input;
    if (operation.scope !== "shared")
      throw artifactRecordError(
        "unavailable",
        "Personal storage is not available on a public page",
      );
    if (isWrite(operation))
      throw artifactRecordError("forbidden", "Public pages are read-only");
    if (!share.publicRecordCollections.includes(operation.collection))
      throw artifactRecordError(
        "forbidden",
        "This collection is not shared publicly",
      );
    const artifact = await findArtifactRecord({
      teamId: share.teamId,
      workspaceId: share.workspaceId,
      artifactId: share.targetId,
    });
    if (
      !artifact ||
      artifact.status !== "ready" ||
      artifact.artifactType !== HTML_ARTIFACT_TYPE
    )
      throw unavailable();
    const version = await findCurrentReadyArtifactVersionRecord({
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      expectedArtifactType: HTML_ARTIFACT_TYPE,
    });
    if (!version) throw unavailable();
    if (!htmlArtifactRecordCapabilities(version.contentJson).shared)
      throw artifactRecordError(
        "forbidden",
        "This version does not declare shared storage",
      );
    if (!(await findActiveSharedApproval(version.versionId)))
      throw artifactRecordError(
        "forbidden",
        "Shared data access for this version has not been approved",
        { reason: "capability_not_approved" },
      );
    await this.limit(`share:${share.id}:${input.clientKey}`, false);
    return this.run({
      operation,
      partition: {
        artifactId: artifact.id,
        scope: "shared",
        ownerUserId: null,
      },
      teamId: artifact.teamId,
      workspaceId: artifact.workspaceId,
      actorUserId: "public",
      versionId: version.versionId,
    });
  }

  /** What the host needs to render approval and consent prompts. */
  async status(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }) {
    const context = await this.loadVersion(input);
    const [approval, consented, author] = await Promise.all([
      context.capabilities.shared
        ? findActiveSharedApproval(context.versionId)
        : Promise.resolve(null),
      context.capabilities.shared
        ? hasSharedConsent({
            userId: input.userId,
            versionId: context.versionId,
          })
        : Promise.resolve(false),
      findVersionAuthor(context.versionId),
    ]);
    const names = await findUserNames(
      [author, approval?.approvedBy].filter((id): id is string => Boolean(id)),
    );
    const person = (id: string | null | undefined) =>
      id ? { id, name: names.get(id) ?? null } : null;
    return {
      storage: context.capabilities.storage,
      shared: context.capabilities.shared,
      author: person(author),
      approval: approval
        ? {
            approvedBy: person(approval.approvedBy),
            approvedAt: approval.approvedAt.toISOString(),
          }
        : null,
      consented,
      canApprove:
        context.capabilities.shared &&
        workspaceRoleSatisfies(context.access.role, "editor"),
    };
  }

  private async requireApprover(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }) {
    const context = await this.loadVersion(input);
    if (!context.capabilities.shared)
      throw artifactRecordError(
        "invalid_request",
        "This version does not request shared storage",
      );
    if (!workspaceRoleSatisfies(context.access.role, "editor"))
      throw artifactRecordError(
        "forbidden",
        "Only workspace editors and admins can approve shared data access",
      );
    return context;
  }

  async approveShared(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }) {
    const context = await this.requireApprover(input);
    const approval = await approveShared({
      versionId: context.versionId,
      artifactId: context.artifactId,
      teamId: context.teamId,
      userId: input.userId,
    });
    await teamAuditService.record({
      teamId: context.teamId,
      actorUserId: input.userId,
      action: "artifact.storage_shared_approved",
      targetType: "artifact",
      targetId: context.artifactId,
      metadata: { versionId: context.versionId },
    });
    return { approvedAt: approval.approvedAt.toISOString() };
  }

  async revokeShared(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }) {
    const context = await this.requireApprover(input);
    const revoked = await revokeShared({
      versionId: context.versionId,
      userId: input.userId,
    });
    if (revoked)
      await teamAuditService.record({
        teamId: context.teamId,
        actorUserId: input.userId,
        action: "artifact.storage_shared_revoked",
        targetType: "artifact",
        targetId: context.artifactId,
        metadata: { versionId: context.versionId },
      });
    return { revoked };
  }

  async grantConsent(input: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    userId: string;
  }) {
    const context = await this.loadVersion(input);
    if (!context.capabilities.shared)
      throw artifactRecordError(
        "invalid_request",
        "This version does not request shared storage",
      );
    if (!(await findActiveSharedApproval(context.versionId)))
      throw artifactRecordError(
        "forbidden",
        "Shared data access for this version has not been approved",
        { reason: "capability_not_approved" },
      );
    await grantSharedConsent({
      userId: input.userId,
      versionId: context.versionId,
      artifactId: context.artifactId,
    });
    return { consented: true };
  }

  deleteUserData(userId: string) {
    return deleteUserRecordData(userId);
  }
}

function limitsFor(scope: ArtifactRecordScope) {
  return {
    recordsPerCollection: ARTIFACT_RECORD_LIMITS.recordsPerCollection,
    collectionsPerPartition: ARTIFACT_RECORD_LIMITS.collectionsPerArtifact,
    partitionBytes:
      scope === "user"
        ? ARTIFACT_RECORD_LIMITS.userBytesPerArtifact
        : ARTIFACT_RECORD_LIMITS.sharedBytesPerArtifact,
  };
}

export const artifactRecordsService = new ArtifactRecordsService();
