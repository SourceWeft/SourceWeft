import { randomUUID } from "node:crypto";

/**
 * Allocates an artifact id.
 *
 * Exported so a caller can allocate the id *before* the work that produces the
 * artifact, and hand the same id to `publishPreparedArtifact` afterwards. That
 * matters for billing: an idempotency key derived from the id has to exist
 * before the model call it is meant to make replay-safe, not after it.
 */
export function createArtifactId() {
  return randomUUID();
}
import {
  buildArtifactDownloadUrl,
  buildArtifactPreviewImageUrl,
  buildArtifactPreviewUrl,
} from "./artifact-urls";
import {
  ARTIFACT_LIMITS,
  ARTIFACT_MIME_TYPES,
  extensionForMimeType,
  extensionForPath,
  isArtifactPreviewImageMimeType,
  mimeTypeForPath,
  normalizeMimeType,
} from "@sourceweft/contracts/artifact-files";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import {
  artifactSourceTypeHandlers,
  artifactTypeHandlers,
  type ArtifactBytes,
  type ArtifactPublishDescriptor,
  handlerForArtifactType,
  type ArtifactTypeHandler,
} from "./artifact-type-handlers";
import {
  adapterForSource,
  artifactSourceAdapters,
  type ArtifactSourceAdapter,
  type ArtifactSourceServices,
} from "./source-adapters";
import {
  ArtifactPublishError,
  PublishArtifactInputSchema,
  type PublishArtifactInput,
  type PublishArtifactSuccessOutput,
  type PreviewImageInput,
} from "./schemas";

/**
 * What the host returns when it has inserted a ready artifact row. One shape
 * for every type this capability publishes: the row is generic, only the
 * artifact type passed to the host differs.
 */
export type PublishedArtifactRecord = {
  readonly artifactId: string;
  readonly versionId: string;
};

/** @deprecated Use {@link PublishedArtifactRecord}; kept as an alias. */
export type SlidesArtifactRecord = PublishedArtifactRecord;
/** @deprecated Use {@link PublishedArtifactRecord}; kept as an alias. */
export type FileArtifactRecord = PublishedArtifactRecord;
/** @deprecated Use {@link PublishedArtifactRecord}; kept as an alias. */
export type ImageArtifactRecord = PublishedArtifactRecord;

export type PublishArtifactContext = {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
};

/**
 * What `createArtifactRecord` hands the host for every artifact type. The
 * preview fields are part of it for all types, not just slides: the publisher
 * passes them unconditionally, and a signature that omitted them let a
 * successfully uploaded thumbnail be dropped on the floor without an error.
 */
export type CreateArtifactRecordInput = {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  title: string;
  prompt: string;
  payload: Record<string, unknown>;
  storageBucket: string;
  storageKey: string;
  previewStorageKey?: string | null;
  previewMetadata?: Record<string, unknown> | null;
};

/**
 * The host's generic "insert a ready artifact row" primitive. It takes the
 * artifact type as a parameter, so the host names none of the types this
 * capability publishes — `slides` is ours, and `file`/`image` are top-level
 * media owned by nobody.
 */
export type CreateReadyArtifactRecord = (
  artifactType: string,
  input: CreateArtifactRecordInput,
) => Promise<PublishedArtifactRecord>;

export type PublishArtifactServices = ArtifactSourceServices & {
  readonly artifacts?: {
    readonly createReadyArtifact?: CreateReadyArtifactRecord;
  };
  readonly storage?: ArtifactStorage;
};

export type PublishArtifactOperationInput = {
  readonly context: PublishArtifactContext;
  readonly input: PublishArtifactInput;
  readonly services: PublishArtifactServices;
  readonly sourceAdapters?: readonly ArtifactSourceAdapter[];
  readonly typeHandlers?: readonly ArtifactTypeHandler[];
  readonly toolCallId?: string;
};

export type PublishPreparedArtifactOperationInput = {
  readonly context: PublishArtifactContext;
  readonly descriptor: ArtifactPublishDescriptor;
  readonly previewImage?: PreparedPreviewImage;
  /**
   * Whether the caller asked for a preview image, which is not the same as
   * whether one survived preparation: an oversized preview is dropped rather
   * than failing the publish. Defaults to `previewImage !== undefined`.
   */
  readonly previewImageRequested?: boolean;
  readonly source: ArtifactBytes;
  readonly services: PublishArtifactServices;
  readonly typeHandlers?: readonly ArtifactTypeHandler[];
  readonly toolCallId?: string;
  /**
   * Pre-allocated artifact id. Supply it when the id was needed before this
   * call — e.g. to key billing for the model call that produced the bytes.
   * Defaults to a freshly allocated id.
   */
  readonly artifactId?: string;
};

export type PublishPreparedArtifactResult = {
  readonly artifactId: string;
  readonly output: PublishArtifactSuccessOutput;
  readonly record: PublishedArtifactRecord;
  readonly storageBucket: string;
  readonly storageKey: string;
};

/**
 * The extension a preview image path must carry to be believed. Narrower than
 * the shared extension table on purpose: only formats on the preview allowlist
 * count, so a `.gif` path is rejected rather than silently retyped.
 */
function previewImageMimeTypeForExtension(extension: string) {
  const mimeType = mimeTypeForPath(`preview${extension}`, "");
  return isArtifactPreviewImageMimeType(mimeType) ? mimeType : "";
}

export type PreparedPreviewImage = {
  readonly altText: string | null;
  readonly byteLength: number;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string;
};

type UploadedPreviewImage = {
  readonly altText: string | null;
  readonly byteLength: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly storageKey: string;
};

function previewImageFileNameForContentType(contentType: string) {
  return `preview${extensionForMimeType(contentType, ".jpg")}`;
}

function preparePreviewImage(input: {
  readonly altText?: string;
  readonly image: {
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly path: string;
  };
}): PreparedPreviewImage | null {
  const extension = extensionForPath(input.image.path);
  const mimeTypeFromExtension = previewImageMimeTypeForExtension(extension);
  const normalizedMimeType = normalizeMimeType(input.image.mimeType);
  const contentType =
    normalizedMimeType && normalizedMimeType !== ARTIFACT_MIME_TYPES.binary
      ? normalizedMimeType
      : mimeTypeFromExtension ||
        normalizeMimeType(mimeTypeForPath(input.image.path));

  if (!isArtifactPreviewImageMimeType(contentType)) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      `expected preview image MIME type image/jpeg, image/png, or image/webp; received ${contentType || "unknown"}`,
    );
  }
  if (
    mimeTypeFromExtension &&
    normalizedMimeType &&
    normalizedMimeType !== ARTIFACT_MIME_TYPES.binary &&
    normalizedMimeType !== mimeTypeFromExtension
  ) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      `preview image extension ${extension} does not match MIME type ${normalizedMimeType}`,
    );
  }
  if (input.image.bytes.byteLength === 0) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      "preview image is empty",
    );
  }
  if (input.image.bytes.byteLength > ARTIFACT_LIMITS.previewImageBytes) {
    // A thumbnail is an enhancement, not the deliverable. Failing the whole
    // publish because the preview was oversized threw away work the user asked
    // for to protect a decoration, so the artifact now publishes without one.
    // Malformed previews still throw: those are input errors worth reporting.
    return null;
  }

  return {
    altText:
      typeof input.altText === "string" && input.altText.trim().length > 0
        ? input.altText.trim()
        : null,
    byteLength: input.image.bytes.byteLength,
    bytes: input.image.bytes,
    contentType,
    fileName: previewImageFileNameForContentType(contentType),
  };
}

async function readPreviewImage(input: {
  readonly previewImage: PreviewImageInput;
  readonly publishInput: PublishArtifactInput;
  readonly services: PublishArtifactServices;
  readonly sourceAdapters?: readonly ArtifactSourceAdapter[];
}) {
  const adapter = adapterForSource(
    input.previewImage.source,
    input.sourceAdapters ?? artifactSourceAdapters,
  );
  if (!adapter) {
    throw new ArtifactPublishError(
      "ARTIFACT_SOURCE_INVALID",
      `previewImage.source.kind is not supported: ${input.previewImage.source.kind}`,
    );
  }

  const image = await adapter.read({
    publishInput: {
      ...input.publishInput,
      previewImage: undefined,
      source: input.previewImage.source,
    },
    services: input.services,
  });

  return preparePreviewImage({
    altText: input.previewImage.altText,
    image,
  });
}

export async function publishArtifact(
  input: PublishArtifactOperationInput,
): Promise<PublishArtifactSuccessOutput> {
  const parsed = PublishArtifactInputSchema.parse(input.input);
  const handler = handlerForArtifactType(
    parsed.artifactType,
    input.typeHandlers ?? artifactSourceTypeHandlers,
  );
  if (!handler) {
    throw new ArtifactPublishError(
      "ARTIFACT_TYPE_UNSUPPORTED",
      `artifactType is not supported: ${parsed.artifactType}`,
    );
  }

  const adapter = adapterForSource(
    parsed.source,
    input.sourceAdapters ?? artifactSourceAdapters,
  );
  if (!adapter) {
    throw new ArtifactPublishError(
      "ARTIFACT_SOURCE_INVALID",
      `source.kind is not supported: ${parsed.source.kind}`,
    );
  }

  const source = await adapter.read({
    publishInput: parsed,
    services: input.services,
  });
  const previewImage = parsed.previewImage
    ? (await readPreviewImage({
        previewImage: parsed.previewImage,
        publishInput: parsed,
        services: input.services,
        sourceAdapters: input.sourceAdapters,
      })) ?? undefined
    : undefined;

  return (
    await publishPreparedArtifact({
      context: input.context,
      descriptor: parsed,
      previewImage,
      previewImageRequested: parsed.previewImage !== undefined,
      source,
      services: input.services,
      typeHandlers: handler ? [handler] : input.typeHandlers,
      toolCallId: input.toolCallId,
    })
  ).output;
}

export async function publishPreparedArtifact(
  input: PublishPreparedArtifactOperationInput,
): Promise<PublishPreparedArtifactResult> {
  const handler = handlerForArtifactType(
    input.descriptor.artifactType,
    input.typeHandlers ?? artifactTypeHandlers,
  );
  if (!handler) {
    throw new ArtifactPublishError(
      "ARTIFACT_TYPE_UNSUPPORTED",
      `artifactType is not supported: ${input.descriptor.artifactType}`,
    );
  }

  const preparedArtifact = handler.prepare({
    publishInput: input.descriptor,
    source: input.source,
  });
  // These two invariants are about the *request*: slides publishing is gated on
  // the caller having run visual QA and passed the frame. Whether that frame
  // then survives the size check is a separate, best-effort concern.
  const previewImageRequested =
    input.previewImageRequested ?? input.previewImage !== undefined;
  if (preparedArtifact.artifactType === "slides" && !previewImageRequested) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      "previewImage is required for slides artifacts; use PREVIEW_IMAGE_PATH from final PPTX visual QA",
    );
  }
  if (previewImageRequested && preparedArtifact.artifactType !== "slides") {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      "previewImage is only supported for slides artifacts",
    );
  }

  const storage = input.services.storage;
  if (!storage) {
    throw new ArtifactPublishError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "artifact storage service is not available",
    );
  }
  if (!input.services.artifacts?.createReadyArtifact) {
    throw new ArtifactPublishError(
      "ARTIFACT_RECORD_UNAVAILABLE",
      `${preparedArtifact.artifactType} artifact record service is not available`,
    );
  }

  const artifactId = input.artifactId ?? createArtifactId();
  const storageKey = storage.buildArtifactStorageKey({
    workspaceId: input.context.workspaceId,
    artifactId,
    fileName: preparedArtifact.fileName,
  });

  await storage.upload({
    key: storageKey,
    body: input.source.bytes,
    contentType: preparedArtifact.contentType,
  });
  const uploadedPreviewImage = input.previewImage
    ? await uploadPreviewImage({
        artifactId,
        previewImage: input.previewImage,
        storage,
        workspaceId: input.context.workspaceId,
      })
    : undefined;

  const storageBucket = storage.getBucketName();
  const record = await createArtifactRecord({
    artifactId,
    context: input.context,
    descriptor: input.descriptor,
    preparedArtifact,
    services: input.services,
    storageBucket,
    storageKey,
    toolCallId: input.toolCallId,
    previewImage: uploadedPreviewImage,
  });

  const artifactUrl = buildArtifactPreviewUrl({
    artifactId,
    workspaceId: input.context.workspaceId,
  });
  const downloadUrl = buildArtifactDownloadUrl({
    artifactId,
    workspaceId: input.context.workspaceId,
  });
  const output = preparedArtifact.toOutput({
    artifactId,
    artifactUrl,
    downloadUrl,
    title: input.descriptor.title,
  });
  const previewImageUrl =
    uploadedPreviewImage && output.artifactType === "slides"
      ? buildArtifactPreviewImageUrl({
          artifactId,
          workspaceId: input.context.workspaceId,
        })
      : undefined;
  const outputWithPreviewImage = previewImageUrl
    ? {
        ...output,
        previewImageUrl,
        preview_image_url: previewImageUrl,
      }
    : output;

  return {
    artifactId,
    output: outputWithPreviewImage,
    record,
    storageBucket,
    storageKey,
  };
}

async function uploadPreviewImage(input: {
  readonly artifactId: string;
  readonly previewImage: PreparedPreviewImage;
  readonly storage: NonNullable<PublishArtifactServices["storage"]>;
  readonly workspaceId: string;
}): Promise<UploadedPreviewImage> {
  const storageKey = input.storage.buildArtifactStorageKey({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    fileName: input.previewImage.fileName,
  });
  await input.storage.upload({
    key: storageKey,
    body: input.previewImage.bytes,
    contentType: input.previewImage.contentType,
  });
  return {
    altText: input.previewImage.altText,
    byteLength: input.previewImage.byteLength,
    fileName: input.previewImage.fileName,
    mimeType: input.previewImage.contentType,
    storageKey,
  };
}

async function createArtifactRecord(input: {
  readonly artifactId: string;
  readonly context: PublishArtifactContext;
  readonly descriptor: ArtifactPublishDescriptor;
  readonly preparedArtifact: ReturnType<ArtifactTypeHandler["prepare"]>;
  readonly services: PublishArtifactServices;
  readonly storageBucket: string;
  readonly storageKey: string;
  readonly toolCallId?: string;
  readonly previewImage?: UploadedPreviewImage;
}): Promise<PublishedArtifactRecord> {
  const createRecord = input.services.artifacts?.createReadyArtifact;

  if (!createRecord) {
    throw new ArtifactPublishError(
      "ARTIFACT_TYPE_UNSUPPORTED",
      `artifact record creation is not implemented for ${input.preparedArtifact.artifactType}`,
    );
  }

  return createRecord(input.preparedArtifact.artifactType, {
    artifactId: input.artifactId,
    teamId: input.context.teamId,
    workspaceId: input.context.workspaceId,
    threadId: input.context.threadId,
    userId: input.context.userId,
    title: input.descriptor.title,
    prompt: input.descriptor.description ?? input.descriptor.title,
    storageBucket: input.storageBucket,
    storageKey: input.storageKey,
    previewStorageKey: input.previewImage?.storageKey ?? null,
    previewMetadata: input.previewImage
      ? {
          altText: input.previewImage.altText,
          byteLength: input.previewImage.byteLength,
          fileName: input.previewImage.fileName,
          mimeType: input.previewImage.mimeType,
        }
      : null,
    payload: {
      ...input.preparedArtifact.payload,
      storageKey: input.storageKey,
      toolCallId: input.toolCallId,
    },
  });
}
