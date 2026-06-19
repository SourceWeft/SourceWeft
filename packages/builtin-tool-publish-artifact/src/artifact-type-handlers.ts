import {
  ARTIFACT_MIME_TYPES,
  extensionForPath,
  fileNameForPathOrTitle,
  fileNameForTitle,
  mimeTypeForPath,
} from "./artifact-files";
import type { ArtifactSourceBytes } from "./source-adapters";
import {
  ArtifactPublishError,
  type PublishArtifactSuccessOutput,
} from "./schemas";
import { validatePptxPackage } from "./sandbox-output";

export type ArtifactPublishDescriptor = {
  readonly artifactType: string;
  readonly title: string;
  readonly description?: string;
  readonly previewImage?: unknown;
  readonly source?: unknown;
  readonly qa?: {
    readonly warnings?: readonly string[];
  } | null;
};

export type ArtifactBytes = Omit<ArtifactSourceBytes, "source"> & {
  readonly source?: unknown;
  readonly payload?: Record<string, unknown>;
};

export type ArtifactTypeHandlerResult = {
  readonly artifactType: PublishArtifactSuccessOutput["artifactType"];
  readonly byteLength: number;
  readonly contentType: string;
  readonly fileName: string;
  readonly payload: Record<string, unknown>;
  readonly toOutput: (input: {
    readonly artifactId: string;
    readonly artifactUrl: string;
    readonly downloadUrl: string;
    readonly title: string;
  }) => PublishArtifactSuccessOutput;
};

export type ArtifactTypeHandler = {
  readonly artifactType: string;
  readonly prepare: (input: {
    readonly publishInput: ArtifactPublishDescriptor;
    readonly source: ArtifactBytes;
  }) => ArtifactTypeHandlerResult;
};

const MAX_PPTX_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  ARTIFACT_MIME_TYPES.png,
  ARTIFACT_MIME_TYPES.jpeg,
  ARTIFACT_MIME_TYPES.webp,
]);

const slidesTypeHandler: ArtifactTypeHandler = {
  artifactType: "slides",
  prepare(input) {
    const source = input.source;
    const extension = extensionForPath(source.path);
    if (extension !== ".pptx") {
      throw new ArtifactPublishError(
        "PPTX_OUTPUT_INVALID_EXTENSION",
        `path must end with .pptx: ${source.path}`,
      );
    }
    if (
      source.mimeType &&
      source.mimeType !== ARTIFACT_MIME_TYPES.binary &&
      source.mimeType !== ARTIFACT_MIME_TYPES.pptx
    ) {
      throw new ArtifactPublishError(
        "PPTX_OUTPUT_INVALID_MIME",
        `expected PPTX MIME type, received ${source.mimeType}`,
      );
    }
    if (source.bytes.byteLength === 0) {
      throw new ArtifactPublishError("PPTX_PACKAGE_INVALID", "file is empty");
    }
    if (source.bytes.byteLength > MAX_PPTX_BYTES) {
      throw new ArtifactPublishError(
        "PPTX_OUTPUT_TOO_LARGE",
        `${source.bytes.byteLength} bytes exceeds limit of ${MAX_PPTX_BYTES} bytes`,
      );
    }
    validatePptxPackage(source.bytes);

    const fileName = fileNameForTitle({
      title: input.publishInput.title,
      extension: extension || ".pptx",
    });
    const contentType = source.mimeType || mimeTypeForPath(source.path);

    return {
      artifactType: "slides",
      byteLength: source.bytes.byteLength,
      contentType,
      fileName,
      payload: {
        artifactType: "slides",
        byteLength: source.bytes.byteLength,
        description: input.publishInput.description,
        fileName,
        mimeType: contentType,
        qa: input.publishInput.qa ?? null,
        source: input.publishInput.source ?? source.source ?? null,
        title: input.publishInput.title,
        ...(source.payload ?? {}),
      },
      toOutput(outputInput) {
        const artifactUrl = outputInput.artifactUrl;
        return {
          ok: true,
          type: "presentation_artifact_result",
          status: "ready",
          artifactId: outputInput.artifactId,
          artifact_id: outputInput.artifactId,
          artifactType: "slides",
          title: outputInput.title,
          artifactUrl,
          artifact_url: artifactUrl,
          pptx_url: artifactUrl,
          byteLength: source.bytes.byteLength,
          byte_length: source.bytes.byteLength,
          editable: true,
          fileName,
          file_name: fileName,
          generation_mode: "editable_native",
          qaWarnings: [...(input.publishInput.qa?.warnings ?? [])],
        };
      },
    };
  },
};

const fileTypeHandler: ArtifactTypeHandler = {
  artifactType: "file",
  prepare(input) {
    const source = input.source;
    if (source.bytes.byteLength === 0) {
      throw new ArtifactPublishError("ARTIFACT_FILE_EMPTY", "file is empty");
    }
    if (source.bytes.byteLength > MAX_FILE_BYTES) {
      throw new ArtifactPublishError(
        "ARTIFACT_FILE_TOO_LARGE",
        `${source.bytes.byteLength} bytes exceeds limit of ${MAX_FILE_BYTES} bytes`,
      );
    }

    const fileName = fileNameForPathOrTitle({
      path: source.path,
      title: input.publishInput.title,
    });
    const contentType = source.mimeType || mimeTypeForPath(source.path);

    return {
      artifactType: "file",
      byteLength: source.bytes.byteLength,
      contentType,
      fileName,
      payload: {
        artifactType: "file",
        byteLength: source.bytes.byteLength,
        description: input.publishInput.description,
        fileName,
        mimeType: contentType,
        source: input.publishInput.source ?? source.source ?? null,
        title: input.publishInput.title,
        ...(source.payload ?? {}),
      },
      toOutput(outputInput) {
        const artifactUrl = outputInput.artifactUrl;
        const downloadUrl = outputInput.downloadUrl;
        return {
          ok: true,
          type: "file_artifact_result",
          status: "ready",
          artifactId: outputInput.artifactId,
          artifact_id: outputInput.artifactId,
          artifactType: "file",
          title: outputInput.title,
          artifactUrl,
          artifact_url: artifactUrl,
          downloadUrl,
          download_url: downloadUrl,
          byteLength: source.bytes.byteLength,
          byte_length: source.bytes.byteLength,
          fileName,
          file_name: fileName,
          mimeType: contentType,
          mime_type: contentType,
        };
      },
    };
  },
};

const imageTypeHandler: ArtifactTypeHandler = {
  artifactType: "image",
  prepare(input) {
    const source = input.source;
    if (source.bytes.byteLength === 0) {
      throw new ArtifactPublishError("ARTIFACT_FILE_EMPTY", "file is empty");
    }
    if (source.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ArtifactPublishError(
        "ARTIFACT_FILE_TOO_LARGE",
        `${source.bytes.byteLength} bytes exceeds limit of ${MAX_IMAGE_BYTES} bytes`,
      );
    }

    const contentType = source.mimeType || mimeTypeForPath(source.path);
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(contentType)) {
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_INVALID",
        `expected image MIME type, received ${contentType}`,
      );
    }

    const fileName = fileNameForPathOrTitle({
      path: source.path,
      title: input.publishInput.title,
    });

    return {
      artifactType: "image",
      byteLength: source.bytes.byteLength,
      contentType,
      fileName,
      payload: {
        artifactType: "image",
        byteLength: source.bytes.byteLength,
        description: input.publishInput.description,
        fileName,
        mimeType: contentType,
        source: input.publishInput.source ?? source.source ?? null,
        title: input.publishInput.title,
        ...(source.payload ?? {}),
      },
      toOutput(outputInput) {
        const artifactUrl = outputInput.artifactUrl;
        return {
          ok: true,
          type: "generated_image",
          status: "ready",
          artifactId: outputInput.artifactId,
          artifact_id: outputInput.artifactId,
          artifactType: "image",
          title: outputInput.title,
          artifactUrl,
          artifact_url: artifactUrl,
          byteLength: source.bytes.byteLength,
          byte_length: source.bytes.byteLength,
          fileName,
          file_name: fileName,
          mimeType: contentType,
          mime_type: contentType,
        };
      },
    };
  },
};

export const artifactTypeHandlers = [
  slidesTypeHandler,
  fileTypeHandler,
  imageTypeHandler,
] as const;

export const artifactSourceTypeHandlers = [
  slidesTypeHandler,
  fileTypeHandler,
] as const;

export function handlerForArtifactType(
  artifactType: string,
  handlers: readonly ArtifactTypeHandler[] = artifactTypeHandlers,
) {
  return handlers.find((handler) => handler.artifactType === artifactType) ?? null;
}
