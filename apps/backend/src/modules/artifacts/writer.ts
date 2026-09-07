import { randomUUID } from "node:crypto";
import {
  ARTIFACT_LIMITS,
  extensionForMimeType,
} from "@sourceweft/contracts/artifact-files";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
  toArtifactError,
  isArtifactError,
} from "@sourceweft/contracts/artifact-errors";
import {
  artifactErrorFromIssues,
  primaryArtifactAttachment,
  validateArtifactPublishSpec,
  type ArtifactPreviewImage,
  type ArtifactPublishSpec,
  type ArtifactWriteContext,
} from "@sourceweft/contracts/artifact-write";
import { artifactTypeSchema } from "@sourceweft/contracts/artifacts";
import { artifactStorage } from "../sources/storage";
import { logger } from "../../shared/logger";
import {
  createPendingArtifactRecord,
  createReadyArtifactRecord,
  findArtifactRecordByRequestKey,
  findArtifactWriteReferences,
  markArtifactFailed,
  markArtifactReady,
} from "./repository";

/**
 * The one way an artifact is written.
 *
 * Two lifecycles exist and they are not variants of each other:
 *
 *   publishArtifact(spec)                 — the artifact is finished already
 *   openArtifact(spec) -> completeArtifact/failArtifact
 *                                         — the artifact is a promise the user
 *                                           can watch while it is produced
 *
 * What they share is everything between "here is a spec" and "the row is
 * committed": validation, byte upload, and the transactional commit itself. `prepareArtifactWrite` is that shared middle;
 * the two entry points differ only in which committed state they ask for, and
 * both land in a repository function that writes the row and its version inside
 * one transaction.
 *
 * The host names no artifact type, and there is no write-side handler registry:
 * a producer validates its own type before it calls here, so the checks below
 * are the type-agnostic ones only.
 */

export type ArtifactWriterDeps = {
  readonly storage: ArtifactStorage;
  readonly repository: {
    readonly createReady: typeof createReadyArtifactRecord;
    readonly createPending: typeof createPendingArtifactRecord;
    readonly markReady: typeof markArtifactReady;
    readonly markFailed: typeof markArtifactFailed;
    readonly findByRequestKey: typeof findArtifactRecordByRequestKey;
    readonly findWriteReferences: typeof findArtifactWriteReferences;
  };
  readonly newArtifactId?: () => string;
};

export type PublishArtifactResult = {
  readonly artifactId: string;
  readonly versionId: string;
  /**
   * True when an idempotency key resolved to an artifact that already existed,
   * so this call produced no new artifact or version. Any objects uploaded
   * before losing a concurrent creation race have been cleaned up.
   * Callers that report "created" to a user need to tell the two apart.
   */
  readonly reused: boolean;
};

export type OpenArtifactResult = {
  readonly artifactId: string;
  readonly reused: boolean;
};

type ArtifactTypeName = Parameters<
  typeof createReadyArtifactRecord
>[0]["artifactType"];

type ArtifactStatus = Parameters<
  typeof findArtifactRecordByRequestKey
>[0]["statuses"][number];

const ARTIFACT_TYPE_NAMES: ReadonlySet<string> = new Set(
  artifactTypeSchema.options,
);

/**
 * Statuses whose row an idempotency key may resolve to.
 *
 * The two lifecycles want different sets, and the difference is the whole
 * two-phase problem: `openArtifact` is where a key first becomes visible, but
 * the artifact is not `ready` until `completeArtifact`, so a retried open must
 * be allowed to find its own in-flight `pending` row. A one-shot publish, by
 * contrast, only ever hands back a finished artifact — a `pending` row under
 * the same key belongs to a two-phase writer that is still running, and is not
 * this caller's to return.
 */
const REUSE_STATUSES = {
  publish: ["ready"],
  open: ["pending", "running", "ready"],
} as const;

type PreparedWrite = {
  readonly payload: Record<string, unknown>;
  readonly storageBucket: string | null;
  readonly storageKey: string | null;
  readonly previewStorageKey: string | null;
  readonly previewMetadata: Record<string, unknown> | null;
  /** Every unique key attempted before the repository commit boundary. */
  readonly attemptedStorageKeys: readonly string[];
};

function throwArtifactWriteAbortReason(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("The artifact publication was aborted.", "AbortError")
  );
}

function previewFileName(preview: ArtifactPreviewImage) {
  const provided = preview.fileName?.trim();
  return provided && provided.length > 0
    ? provided
    : `preview${extensionForMimeType(preview.contentType, ".jpg")}`;
}

export class ArtifactWriter {
  constructor(private readonly deps: ArtifactWriterDeps) {}

  private newId() {
    return (this.deps.newArtifactId ?? randomUUID)();
  }

  /**
   * Reject an artifact type the schema does not know, as a validation error the
   * caller can act on.
   *
   * Without this the cast below reached the repository unchecked and the type
   * died on the column's CHECK constraint, surfacing as
   * ARTIFACT_RECORD_UNAVAILABLE — an infrastructure code, therefore
   * unrecoverable, therefore telling an agent "the database is broken" when the
   * truth was "you asked for an artifact type that does not exist". It is also
   * what made `typeUnsupported` a code that was defined and never thrown.
   */
  private assertKnownArtifactType(artifactType: string): ArtifactTypeName {
    if (!ARTIFACT_TYPE_NAMES.has(artifactType)) {
      throw new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.typeUnsupported,
        message: `unsupported artifact type: ${artifactType}`,
        details: "artifactType",
      });
    }
    return artifactType as ArtifactTypeName;
  }

  /**
   * Resolve `idempotency.requestKey` to an artifact that already exists.
   *
   * Called before validation and before any upload on both lifecycles: a hit
   * that had already written its bytes would leave objects in the bucket for an
   * artifact this call did not create and nothing will ever reference.
   *
   * The repository repeats this check under the shared request-key lock before
   * inserting. This fast check saves uploads; the locked check supplies safety.
   */
  private async findReusable(input: {
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    readonly statuses: readonly ArtifactStatus[];
  }) {
    const requestKey = input.spec.idempotency?.requestKey?.trim();
    if (!requestKey) {
      return null;
    }
    try {
      return await this.deps.repository.findByRequestKey({
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        threadId: input.context.threadId,
        userId: input.context.userId,
        artifactType: this.assertKnownArtifactType(input.spec.artifactType),
        requestKey,
        statuses: input.statuses,
      });
    } catch (error) {
      throw toArtifactError(
        error,
        ARTIFACT_WRITE_ERROR_CODES.recordUnavailable,
      );
    }
  }

  private requestKeyOf(spec: ArtifactPublishSpec): string | null {
    const requestKey = spec.idempotency?.requestKey?.trim();
    return requestKey && requestKey.length > 0 ? requestKey : null;
  }

  private async cleanupStorageKeys(keys: readonly string[]) {
    const uniqueKeys = [...new Set(keys)];
    const results = await Promise.allSettled(
      uniqueKeys.map((key) => this.deps.storage.delete({ key })),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      logger.warn("Artifact object cleanup failed", {
        failedKeys: uniqueKeys.filter(
          (_, index) => results[index]?.status === "rejected",
        ),
      });
      throw new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.storageUnavailable,
        message: `failed to clean up ${failed.length} uncommitted artifact object(s)`,
      });
    }
  }

  private async cleanupAfterFailure(keys: readonly string[], primary: unknown) {
    try {
      await this.cleanupStorageKeys(keys);
    } catch {
      // cleanupStorageKeys already logged the exact failed keys. Preserve the
      // conflict/cancellation/upload failure that determines the caller's action.
      logger.warn(
        "Artifact cleanup failed while preserving the primary error",
        {
          code: isArtifactError(primary) ? primary.code : undefined,
        },
      );
    }
  }

  private async inspectUncertainCommit(
    artifactId: string,
    context: ArtifactWriteContext,
    keys: readonly string[],
  ) {
    if (keys.length === 0) return;
    try {
      const references = await this.deps.repository.findWriteReferences({
        artifactId,
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        keys,
      });
      // A missing row/key is not proof of rollback: the original transaction
      // may still be finishing, and historical primary pointers are not stored.
      logger.warn("Uncertain artifact commit; retaining attempted objects", {
        artifactId,
        workspaceId: context.workspaceId,
        attemptedStorageKeys: keys,
        ...references,
      });
    } catch (error) {
      logger.warn(
        "Artifact commit verification failed; retaining attempted objects",
        {
          artifactId,
          workspaceId: context.workspaceId,
          attemptedStorageKeys: keys,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Validate, shape the payload, and put every byte in object storage.
   *
   * Uploads happen here — before the row is touched — and validation happens
   * before the uploads. Ordered the other way round, a rejected spec would
   * already have left objects in the bucket that nothing references and nothing
   * will ever collect.
   */
  private async prepareArtifactWrite(input: {
    readonly artifactId: string;
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    readonly signal?: AbortSignal;
  }): Promise<PreparedWrite> {
    const { artifactId, context, spec } = input;
    throwArtifactWriteAbortReason(input.signal);

    const issueError = artifactErrorFromIssues(
      validateArtifactPublishSpec(spec),
    );
    if (issueError) {
      throw issueError;
    }
    this.assertKnownArtifactType(spec.artifactType);

    const payload = spec.payload;
    const primary = primaryArtifactAttachment(spec);

    let storageBucket: string | null = null;
    let storageKey: string | null = null;
    let previewStorageKey: string | null = null;
    let previewMetadata: Record<string, unknown> | null = null;
    const attemptedStorageKeys: string[] = [];

    try {
      for (const attachment of spec.attachments ?? []) {
        throwArtifactWriteAbortReason(input.signal);
        const key = this.deps.storage.buildArtifactStorageKey({
          workspaceId: context.workspaceId,
          artifactId,
          fileName: attachment.fileName,
        });
        attemptedStorageKeys.push(key);
        await this.deps.storage.upload({
          key,
          body: attachment.bytes,
          contentType: attachment.contentType,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        throwArtifactWriteAbortReason(input.signal);
        if (attachment === primary) {
          storageBucket = this.deps.storage.getBucketName();
          storageKey = key;
        }
      }

      // A thumbnail is an enhancement, never the deliverable: an oversized one
      // is dropped rather than failing a write the user asked for. Malformed
      // previews are the producer's business, so they are already gone by here.
      const preview = spec.preview;
      if (
        preview &&
        preview.bytes.byteLength > 0 &&
        preview.bytes.byteLength <= ARTIFACT_LIMITS.previewImageBytes
      ) {
        throwArtifactWriteAbortReason(input.signal);
        const fileName = previewFileName(preview);
        const key = this.deps.storage.buildArtifactStorageKey({
          workspaceId: context.workspaceId,
          artifactId,
          fileName,
        });
        attemptedStorageKeys.push(key);
        await this.deps.storage.upload({
          key,
          body: preview.bytes,
          contentType: preview.contentType,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        throwArtifactWriteAbortReason(input.signal);
        previewStorageKey = key;
        previewMetadata = {
          altText: preview.altText ?? null,
          byteLength: preview.bytes.byteLength,
          fileName,
          mimeType: preview.contentType,
        };
      }
    } catch (error) {
      await this.cleanupAfterFailure(attemptedStorageKeys, error);
      throwArtifactWriteAbortReason(input.signal);
      throw toArtifactError(
        error,
        ARTIFACT_WRITE_ERROR_CODES.storageUnavailable,
      );
    }

    return {
      payload,
      storageBucket,
      storageKey,
      previewStorageKey,
      previewMetadata,
      attemptedStorageKeys,
    };
  }

  /** One-shot lifecycle: the artifact exists and is `ready` in one commit. */
  async publishArtifact(input: {
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    /** Pre-allocated when the id had to exist before the work (billing keys). */
    readonly artifactId?: string;
    readonly signal?: AbortSignal;
  }): Promise<PublishArtifactResult> {
    throwArtifactWriteAbortReason(input.signal);
    // Before prepareArtifactWrite, never after: the uploads live in there.
    const existing = await this.findReusable({
      context: input.context,
      spec: input.spec,
      statuses: REUSE_STATUSES.publish,
    });
    throwArtifactWriteAbortReason(input.signal);
    if (existing?.latestVersionId) {
      return {
        artifactId: existing.id,
        versionId: existing.latestVersionId,
        reused: true,
      };
    }

    const artifactId = input.artifactId ?? this.newId();
    const prepared = await this.prepareArtifactWrite({
      artifactId,
      context: input.context,
      spec: input.spec,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // This is the publication linearization point. Before it, cancellation
    // deletes every attempted object and creates no row. Once this check passes,
    // the atomic repository commit owns the outcome and is never rolled back by
    // a later signal.
    try {
      throwArtifactWriteAbortReason(input.signal);
    } catch (error) {
      await this.cleanupAfterFailure(prepared.attemptedStorageKeys, error);
      throw error;
    }

    let record: Awaited<ReturnType<typeof createReadyArtifactRecord>>;
    try {
      record = await this.deps.repository.createReady({
        artifactId,
        artifactType: this.assertKnownArtifactType(input.spec.artifactType),
        requestKey: this.requestKeyOf(input.spec),
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        threadId: input.context.threadId,
        userId: input.context.userId,
        title: input.spec.title,
        prompt: input.spec.prompt ?? input.spec.title,
        payload: prepared.payload,
        storageBucket: prepared.storageBucket,
        storageKey: prepared.storageKey,
        previewStorageKey: prepared.previewStorageKey,
        previewMetadata: prepared.previewMetadata,
      });
    } catch (error) {
      if (
        isArtifactError(error) &&
        error.code === ARTIFACT_WRITE_ERROR_CODES.stateConflict
      )
        await this.cleanupAfterFailure(prepared.attemptedStorageKeys, error);
      else
        await this.inspectUncertainCommit(
          artifactId,
          input.context,
          prepared.attemptedStorageKeys,
        );
      throw toArtifactError(
        error,
        ARTIFACT_WRITE_ERROR_CODES.recordUnavailable,
      );
    }
    if (record.reused)
      await this.cleanupStorageKeys(prepared.attemptedStorageKeys);
    return {
      artifactId: record.artifactId,
      versionId: record.versionId,
      reused: record.reused,
    };
  }

  /**
   * Two-phase lifecycle, phase one: a `pending` row the client can already see.
   *
   * No bytes are accepted here even though the spec type allows them — an
   * attachment at open time would be storage written for an artifact that may
   * never complete. Phase two is where bytes belong.
   */
  async openArtifact(input: {
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    readonly artifactId?: string;
  }): Promise<OpenArtifactResult> {
    // A retried open is the case that makes idempotency worth having on this
    // lifecycle: the first attempt may already have committed its pending row,
    // and handing that row back is the only answer that does not leave the user
    // watching two artifacts for one request.
    const existing = await this.findReusable({
      context: input.context,
      spec: input.spec,
      statuses: REUSE_STATUSES.open,
    });
    if (existing) {
      return { artifactId: existing.id, reused: true };
    }

    const artifactId = input.artifactId ?? this.newId();
    const issueError = artifactErrorFromIssues(
      validateArtifactPublishSpec(input.spec),
    );
    if (issueError) {
      throw issueError;
    }
    const artifactType = this.assertKnownArtifactType(input.spec.artifactType);

    try {
      const record = await this.deps.repository.createPending({
        artifactId,
        artifactType,
        requestKey: this.requestKeyOf(input.spec),
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        threadId: input.context.threadId,
        userId: input.context.userId,
        title: input.spec.title,
        prompt: input.spec.prompt ?? input.spec.title,
        payload: input.spec.payload,
      });
      return { artifactId: record.artifactId, reused: record.reused };
    } catch (error) {
      throw toArtifactError(
        error,
        ARTIFACT_WRITE_ERROR_CODES.recordUnavailable,
      );
    }
  }

  /**
   * Two-phase lifecycle, phase two: `ready`, next version, bytes attached.
   *
   * A null from `markReady` is the compare-and-swap losing: someone else
   * already finished this artifact. That is a `conflict`, not a failure — the
   * caller must not retry it, which is precisely the distinction
   * `artifact-errors.ts` encodes.
   */
  async completeArtifact(input: {
    readonly artifactId: string;
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    /**
     * A thumbnail the caller already put in storage itself, as a pointer.
     *
     * `spec.preview` is the ordinary form and carries bytes, because the writer
     * owning the upload is what keeps key layout in one place. A long-running
     * producer cannot always use it: a deliverable pipeline uploads its cover
     * still mid-run, inside the stage that rendered it, and by the time the run
     * completes the bytes are gone — only the key remains. Rejecting that would
     * mean either holding every frame in memory until the end or re-downloading
     * an object the writer itself would have written.
     *
     * The key is still the writer's layout: producers build it with
     * `buildArtifactStorageKey` under the same artifact id, so this is the same
     * object the bytes path would have produced, handed over one step later.
     * `spec.preview` wins if both are present.
     */
    readonly storedPreview?: {
      readonly storageKey: string;
      readonly metadata: Record<string, unknown>;
    };
    readonly expectedStatuses?: Parameters<
      typeof markArtifactReady
    >[0]["expectedStatuses"];
    /**
     * The `current_version_no` this run read when it loaded the artifact. Pass
     * it whenever the artifact could already be `ready` (an edit): status alone
     * cannot separate two concurrent republishes of the same artifact.
     */
    readonly expectedVersionNo?: number;
    /** Atomic durable-run activity fence for queued deliverable publication. */
    readonly publishRunFence?: Parameters<
      typeof markArtifactReady
    >[0]["publishRunFence"];
    /** Host invocation cancellation; never sourced from artifact input. */
    readonly signal?: AbortSignal;
  }): Promise<PublishArtifactResult> {
    throwArtifactWriteAbortReason(input.signal);
    const prepared = await this.prepareArtifactWrite({
      artifactId: input.artifactId,
      context: input.context,
      spec: input.spec,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // One preview reaches the row: uploaded bytes if the spec carried them,
    // otherwise the pointer the caller uploaded for itself. Resolved before the
    // repository call so the "omitted means keep what the row has" rule below
    // stays a single condition rather than two overlapping ones.
    const previewStorageKey =
      prepared.previewStorageKey ?? input.storedPreview?.storageKey ?? null;
    const previewMetadata =
      prepared.previewStorageKey !== null
        ? prepared.previewMetadata
        : (input.storedPreview?.metadata ?? null);

    // This is the republish linearization boundary. Before it, cancellation
    // owns the outcome and every object attempted by this call is removed.
    // Once the atomic repository commit starts, that commit owns the outcome.
    try {
      throwArtifactWriteAbortReason(input.signal);
    } catch (error) {
      await this.cleanupAfterFailure(prepared.attemptedStorageKeys, error);
      throw error;
    }

    let record: Awaited<ReturnType<typeof markArtifactReady>>;
    try {
      record = await this.deps.repository.markReady({
        artifactId: input.artifactId,
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        userId: input.context.userId,
        payload: prepared.payload,
        // Omitted rather than null: the repository carries forward whatever the
        // row already points at, which is what a payload-only completion wants.
        ...(prepared.storageBucket
          ? { storageBucket: prepared.storageBucket }
          : {}),
        ...(prepared.storageKey ? { storageKey: prepared.storageKey } : {}),
        ...(previewStorageKey ? { previewStorageKey } : {}),
        ...(previewMetadata ? { previewMetadata } : {}),
        ...(input.expectedStatuses
          ? { expectedStatuses: input.expectedStatuses }
          : {}),
        ...(input.expectedVersionNo === undefined
          ? {}
          : { expectedVersionNo: input.expectedVersionNo }),
        ...(input.publishRunFence
          ? { publishRunFence: input.publishRunFence }
          : {}),
      });
    } catch (error) {
      if (
        isArtifactError(error) &&
        error.code === ARTIFACT_WRITE_ERROR_CODES.stateConflict
      )
        await this.cleanupAfterFailure(prepared.attemptedStorageKeys, error);
      else
        await this.inspectUncertainCommit(
          input.artifactId,
          input.context,
          prepared.attemptedStorageKeys,
        );
      throw toArtifactError(
        error,
        ARTIFACT_WRITE_ERROR_CODES.recordUnavailable,
      );
    }

    if (!record) {
      const conflict = new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.stateConflict,
        message: `artifact ${input.artifactId} is no longer writable by this operation`,
      });
      await this.cleanupAfterFailure(prepared.attemptedStorageKeys, conflict);
      throw conflict;
    }
    return {
      artifactId: record.artifactId,
      versionId: record.versionId,
      reused: false,
    };
  }

  /**
   * Terminal failure for a two-phase artifact. Anything thrown is normalized
   * into the one vocabulary first, so the stored `error_code` is always a code
   * the classification table knows.
   *
   * Tenancy is optional because one caller genuinely cannot always supply it:
   * the BullMQ failure boundary runs on a job that died outside the processor
   * and reads team/workspace out of an untyped job payload. Omitting a field
   * drops it from the WHERE clause, so the row is addressed by id alone —
   * every caller that knows its tenant must pass it, and all of them do.
   */
  async failArtifact(input: {
    readonly artifactId: string;
    readonly context: Partial<
      Pick<ArtifactWriteContext, "teamId" | "workspaceId">
    >;
    readonly error: unknown;
    readonly expectedStatuses?: Parameters<
      typeof markArtifactFailed
    >[0]["expectedStatuses"];
    readonly payload?: Record<string, unknown>;
  }): Promise<{ readonly recorded: boolean; readonly error: ArtifactError }> {
    const error = toArtifactError(input.error);
    const recorded = await this.deps.repository.markFailed({
      artifactId: input.artifactId,
      ...(input.context.teamId ? { teamId: input.context.teamId } : {}),
      ...(input.context.workspaceId
        ? { workspaceId: input.context.workspaceId }
        : {}),
      errorCode: error.code,
      errorMessage: error.message,
      ...(input.expectedStatuses
        ? { expectedStatuses: input.expectedStatuses }
        : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    });
    return { recorded, error };
  }
}

export function createArtifactWriter(
  overrides: Partial<ArtifactWriterDeps> = {},
): ArtifactWriter {
  return new ArtifactWriter({
    storage: overrides.storage ?? artifactStorage,
    repository: overrides.repository ?? {
      createReady: createReadyArtifactRecord,
      createPending: createPendingArtifactRecord,
      markReady: markArtifactReady,
      markFailed: markArtifactFailed,
      findByRequestKey: findArtifactRecordByRequestKey,
      findWriteReferences: findArtifactWriteReferences,
    },
    ...(overrides.newArtifactId
      ? { newArtifactId: overrides.newArtifactId }
      : {}),
  });
}

export const artifactWriter = createArtifactWriter();
