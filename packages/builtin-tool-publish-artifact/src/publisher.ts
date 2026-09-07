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
import type { ArtifactPublisher } from "@sourceweft/contracts/artifact-write";
import type { AgentToolArtifactServices } from "@sourceweft/contracts/agent-tools";
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
  readonly reused: boolean;
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

export type PublishArtifactServices = ArtifactSourceServices & {
  readonly artifacts?: Partial<ArtifactPublisher> &
    Partial<
      Pick<AgentToolArtifactServices, "findArtifact" | "republishArtifact">
    >;
  readonly storage?: ArtifactStorage;
};

export type PublishArtifactOperationInput = {
  readonly context: PublishArtifactContext;
  readonly input: PublishArtifactInput;
  readonly services: PublishArtifactServices;
  readonly sourceAdapters?: readonly ArtifactSourceAdapter[];
  readonly typeHandlers?: readonly ArtifactTypeHandler[];
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
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
  /**
   * Makes a retry of the same request return the artifact the first attempt
   * produced instead of publishing a second one. The key is the caller's to
   * derive, because only the caller knows what "the same request" means.
   */
  readonly requestKey?: string;
  readonly signal?: AbortSignal;
};

export type PublishPreparedArtifactResult = {
  readonly artifactId: string;
  readonly output: PublishArtifactSuccessOutput;
  readonly record: PublishedArtifactRecord;
};

function throwArtifactPublicationAbortReason(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("Artifact publication was aborted.", "AbortError")
  );
}

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
  readonly signal?: AbortSignal;
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
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return preparePreviewImage({
    altText: input.previewImage.altText,
    image,
  });
}

export async function publishArtifact(
  input: PublishArtifactOperationInput,
): Promise<PublishArtifactSuccessOutput> {
  throwArtifactPublicationAbortReason(input.signal);
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
    ...(input.signal ? { signal: input.signal } : {}),
  });
  throwArtifactPublicationAbortReason(input.signal);
  const previewImage = parsed.previewImage
    ? ((await readPreviewImage({
        previewImage: parsed.previewImage,
        publishInput: parsed,
        services: input.services,
        sourceAdapters: input.sourceAdapters,
        ...(input.signal ? { signal: input.signal } : {}),
      })) ?? undefined)
    : undefined;
  throwArtifactPublicationAbortReason(input.signal);

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
      ...(input.signal ? { signal: input.signal } : {}),
    })
  ).output;
}

export async function publishPreparedArtifact(
  input: PublishPreparedArtifactOperationInput,
): Promise<PublishPreparedArtifactResult> {
  throwArtifactPublicationAbortReason(input.signal);
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

  const publish = input.services.artifacts?.publishArtifact;
  if (!publish) {
    throw new ArtifactPublishError(
      "ARTIFACT_RECORD_UNAVAILABLE",
      `${preparedArtifact.artifactType} artifact record service is not available`,
    );
  }

  const republishArtifactId = input.descriptor.republishArtifactId;
  let republishExpectedVersionNo: number | undefined;
  if (republishArtifactId) {
    const findArtifact = input.services.artifacts?.findArtifact;
    const republish = input.services.artifacts?.republishArtifact;
    if (!findArtifact || !republish) {
      throw new ArtifactPublishError(
        "ARTIFACT_RECORD_UNAVAILABLE",
        "republishArtifactId was given but the republish service is not available",
      );
    }
    const existing = await findArtifact({
      teamId: input.context.teamId,
      workspaceId: input.context.workspaceId,
      artifactId: republishArtifactId,
    });
    if (!existing) {
      throw new ArtifactPublishError(
        "ARTIFACT_REPUBLISH_INVALID",
        `republishArtifactId ${republishArtifactId} does not name an artifact in this workspace`,
      );
    }
    if (existing.status !== "ready") {
      throw new ArtifactPublishError(
        "ARTIFACT_REPUBLISH_INVALID",
        `artifact ${republishArtifactId} is ${existing.status}; only a ready artifact can be republished`,
      );
    }
    if (
      existing.artifactType !== undefined &&
      existing.artifactType !== preparedArtifact.artifactType
    ) {
      throw new ArtifactPublishError(
        "ARTIFACT_REPUBLISH_INVALID",
        `artifact ${republishArtifactId} is ${existing.artifactType}, not ${preparedArtifact.artifactType}`,
      );
    }
    republishExpectedVersionNo =
      typeof existing.currentVersionNo === "number"
        ? existing.currentVersionNo
        : undefined;
  }

  // Everything type-specific is already settled: the handler has checked the
  // extension, the MIME type, the size and — for a deck — that the PPTX package
  // really unpacks. What is left is the write itself, which is the host's, so
  // the bytes go across as attachments rather than being uploaded here.
  const publishRecord = (spec: Parameters<typeof publish>[0]["spec"]) => {
    throwArtifactPublicationAbortReason(input.signal);
    return republishArtifactId
      ? input.services.artifacts!.republishArtifact!({
          context: input.context,
          artifactId: republishArtifactId,
          spec,
          ...(republishExpectedVersionNo !== undefined
            ? { expectedVersionNo: republishExpectedVersionNo }
            : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : publish({
          context: input.context,
          ...(input.artifactId ? { artifactId: input.artifactId } : {}),
          spec,
          ...(input.signal ? { signal: input.signal } : {}),
        });
  };
  const record = await publishRecord({
    artifactType: preparedArtifact.artifactType,
    title: input.descriptor.title,
    prompt: input.descriptor.description ?? input.descriptor.title,
    payload: {
      ...preparedArtifact.payload,
      toolCallId: input.toolCallId,
    },
    attachments: [
      {
        fileName: preparedArtifact.fileName,
        contentType: preparedArtifact.contentType,
        bytes: input.source.bytes,
        role: "primary",
      },
    ],
    ...(input.previewImage
      ? {
          preview: {
            bytes: input.previewImage.bytes,
            contentType: input.previewImage.contentType,
            fileName: input.previewImage.fileName,
            altText: input.previewImage.altText,
          },
        }
      : {}),
    ...(input.requestKey
      ? { idempotency: { requestKey: input.requestKey } }
      : {}),
  });
  const artifactId = record.artifactId;

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
    reused: record.reused,
    artifactUrl,
    downloadUrl,
    title: input.descriptor.title,
  });
  const previewImageUrl =
    input.previewImage && output.artifactType === "slides"
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
  };
}
