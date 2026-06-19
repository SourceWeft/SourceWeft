import { randomUUID } from "node:crypto";
import {
  buildArtifactDownloadUrl,
  buildArtifactPreviewImageUrl,
  buildArtifactPreviewUrl,
} from "./artifact-urls";
import {
  ARTIFACT_MIME_TYPES,
  extensionForPath,
  mimeTypeForPath,
  normalizeMimeType,
} from "./artifact-files";
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

export type SlidesArtifactRecord = {
  readonly artifactId: string;
  readonly versionId: string;
};

export type FileArtifactRecord = {
  readonly artifactId: string;
  readonly versionId: string;
};

export type ImageArtifactRecord = {
  readonly artifactId: string;
  readonly versionId: string;
};

export type PublishArtifactContext = {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
};

export type PublishArtifactServices = ArtifactSourceServices & {
  readonly artifacts?: {
    readonly createSlidesArtifactRecord?: (input: {
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
    }) => Promise<SlidesArtifactRecord>;
    readonly createFileArtifactRecord?: (input: {
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
    }) => Promise<FileArtifactRecord>;
    readonly createImageArtifactRecord?: (input: {
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
    }) => Promise<ImageArtifactRecord>;
  };
  readonly storage?: {
    readonly buildArtifactStorageKey: (input: {
      workspaceId: string;
      artifactId: string;
      fileName: string;
    }) => string;
    readonly getContentStorageBucketName: () => string;
    readonly uploadArtifactObject: (input: {
      key: string;
      body: Buffer;
      contentType: string;
    }) => Promise<unknown>;
  };
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
  readonly source: ArtifactBytes;
  readonly services: PublishArtifactServices;
  readonly typeHandlers?: readonly ArtifactTypeHandler[];
  readonly toolCallId?: string;
};

export type PublishPreparedArtifactResult = {
  readonly artifactId: string;
  readonly output: PublishArtifactSuccessOutput;
  readonly record: SlidesArtifactRecord | FileArtifactRecord | ImageArtifactRecord;
  readonly storageBucket: string;
  readonly storageKey: string;
};

const MAX_PREVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const PREVIEW_IMAGE_MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".jpg", ARTIFACT_MIME_TYPES.jpeg],
  [".jpeg", ARTIFACT_MIME_TYPES.jpeg],
  [".png", ARTIFACT_MIME_TYPES.png],
  [".webp", ARTIFACT_MIME_TYPES.webp],
]);
const SUPPORTED_PREVIEW_IMAGE_MIME_TYPES = new Set<string>(
  PREVIEW_IMAGE_MIME_TYPE_BY_EXTENSION.values(),
);

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
  if (contentType === ARTIFACT_MIME_TYPES.png) {
    return "preview.png";
  }
  if (contentType === ARTIFACT_MIME_TYPES.webp) {
    return "preview.webp";
  }
  return "preview.jpg";
}

function preparePreviewImage(input: {
  readonly altText?: string;
  readonly image: {
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly path: string;
  };
}): PreparedPreviewImage {
  const extension = extensionForPath(input.image.path);
  const mimeTypeFromExtension =
    PREVIEW_IMAGE_MIME_TYPE_BY_EXTENSION.get(extension) ?? "";
  const normalizedMimeType = normalizeMimeType(input.image.mimeType);
  const contentType =
    normalizedMimeType && normalizedMimeType !== ARTIFACT_MIME_TYPES.binary
      ? normalizedMimeType
      : mimeTypeFromExtension ||
        normalizeMimeType(mimeTypeForPath(input.image.path));

  if (!SUPPORTED_PREVIEW_IMAGE_MIME_TYPES.has(contentType)) {
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
  if (input.image.bytes.byteLength > MAX_PREVIEW_IMAGE_BYTES) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_TOO_LARGE",
      `${input.image.bytes.byteLength} bytes exceeds limit of ${MAX_PREVIEW_IMAGE_BYTES} bytes`,
    );
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
    ? await readPreviewImage({
        previewImage: parsed.previewImage,
        publishInput: parsed,
        services: input.services,
        sourceAdapters: input.sourceAdapters,
      })
    : undefined;

  return (
    await publishPreparedArtifact({
      context: input.context,
      descriptor: parsed,
      previewImage,
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
  if (preparedArtifact.artifactType === "slides" && !input.previewImage) {
    throw new ArtifactPublishError(
      "ARTIFACT_PREVIEW_IMAGE_INVALID",
      "previewImage is required for slides artifacts; use PREVIEW_IMAGE_PATH from final PPTX visual QA",
    );
  }
  if (input.previewImage && preparedArtifact.artifactType !== "slides") {
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
  const createSlidesArtifactRecord =
    input.services.artifacts?.createSlidesArtifactRecord;
  if (preparedArtifact.artifactType === "slides" && !createSlidesArtifactRecord) {
    throw new ArtifactPublishError(
      "ARTIFACT_RECORD_UNAVAILABLE",
      "slides artifact record service is not available",
    );
  }
  const createFileArtifactRecord =
    input.services.artifacts?.createFileArtifactRecord;
  if (preparedArtifact.artifactType === "file" && !createFileArtifactRecord) {
    throw new ArtifactPublishError(
      "ARTIFACT_RECORD_UNAVAILABLE",
      "file artifact record service is not available",
    );
  }
  const createImageArtifactRecord =
    input.services.artifacts?.createImageArtifactRecord;
  if (preparedArtifact.artifactType === "image" && !createImageArtifactRecord) {
    throw new ArtifactPublishError(
      "ARTIFACT_RECORD_UNAVAILABLE",
      "image artifact record service is not available",
    );
  }

  const artifactId = randomUUID();
  const storageKey = storage.buildArtifactStorageKey({
    workspaceId: input.context.workspaceId,
    artifactId,
    fileName: preparedArtifact.fileName,
  });

  await storage.uploadArtifactObject({
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

  const storageBucket = storage.getContentStorageBucketName();
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
  await input.storage.uploadArtifactObject({
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
}): Promise<SlidesArtifactRecord | FileArtifactRecord | ImageArtifactRecord> {
  const createRecord =
    input.preparedArtifact.artifactType === "slides"
      ? input.services.artifacts!.createSlidesArtifactRecord
      : input.preparedArtifact.artifactType === "file"
        ? input.services.artifacts!.createFileArtifactRecord
        : input.preparedArtifact.artifactType === "image"
          ? input.services.artifacts!.createImageArtifactRecord
          : null;

  if (!createRecord) {
    throw new ArtifactPublishError(
      "ARTIFACT_TYPE_UNSUPPORTED",
      `artifact record creation is not implemented for ${input.preparedArtifact.artifactType}`,
    );
  }

  return createRecord({
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
