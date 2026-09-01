import { artifactTypeSchema } from "@sourceweft/contracts/artifacts";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
} from "@sourceweft/contracts/artifact-errors";
import {
  publishThreadEvent,
  type ThreadEventPayload,
} from "../../shared/notify-hub";
import { logger } from "../../shared/logger";
import {
  commitCurrentRunArtifactPublication,
  type CurrentRunArtifactPublicationInput,
  type CurrentRunArtifactPublicationRepositoryDependencies,
  type CurrentRunArtifactPublicationStage,
} from "./current-run-publication-repository";

export type {
  CurrentRunArtifactPublicationInput,
  CurrentRunArtifactPublicationStage,
} from "./current-run-publication-repository";

type CurrentRunArtifactPublicationServiceDependencies =
  CurrentRunArtifactPublicationRepositoryDependencies & {
    notify?: (event: ThreadEventPayload) => Promise<void>;
  };

function requireNonEmpty(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new ArtifactError({
      code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
      message: `${field} is required`,
      details: field,
    });
  }
  return normalized;
}

function validateHostStorageCoordinates(
  input: CurrentRunArtifactPublicationInput,
) {
  const artifactId = input.artifact.mode.artifactId;
  for (const [field, key] of [
    ["storageKey", input.artifact.storageKey],
    ["previewStorageKey", input.artifact.previewStorageKey],
  ] as const) {
    if (key === undefined || key === null) {
      continue;
    }
    if (!artifactId) {
      throw new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
        message: `${field} requires a host-preallocated artifact id`,
        details: field,
      });
    }
    const expectedPrefix = `workspaces/${input.context.workspaceId}/artifacts/${artifactId}/`;
    if (!key.startsWith(expectedPrefix)) {
      throw new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
        message: `${field} is outside the host-owned artifact prefix`,
        details: field,
      });
    }
  }
}

function validateInput(input: CurrentRunArtifactPublicationInput) {
  const artifactType = artifactTypeSchema.safeParse(
    input.artifact.artifactType,
  );
  if (!artifactType.success) {
    throw new ArtifactError({
      code: ARTIFACT_WRITE_ERROR_CODES.typeUnsupported,
      message: `unsupported artifact type: ${input.artifact.artifactType}`,
      details: "artifactType",
    });
  }
  if (
    !input.artifact.payload ||
    typeof input.artifact.payload !== "object" ||
    Array.isArray(input.artifact.payload)
  ) {
    throw new ArtifactError({
      code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
      message: "payload must be an object",
      details: "payload",
    });
  }
  requireNonEmpty(input.context.actorUserId, "context.actorUserId");
  requireNonEmpty(input.context.runId, "context.runId");
  requireNonEmpty(input.context.sourceToolCallId, "context.sourceToolCallId");
  requireNonEmpty(input.context.sourceToolName, "context.sourceToolName");
  requireNonEmpty(input.context.teamId, "context.teamId");
  requireNonEmpty(input.context.workspaceId, "context.workspaceId");
  requireNonEmpty(input.artifact.semanticRequestKey, "semanticRequestKey");
  requireNonEmpty(input.artifact.title, "title");
  requireNonEmpty(input.artifact.workflowVersion, "workflowVersion");
  validateHostStorageCoordinates(input);
  if (input.artifact.mode.kind === "republish") {
    requireNonEmpty(input.artifact.mode.artifactId, "republishArtifactId");
    if (
      !Number.isInteger(input.artifact.mode.expectedVersionNo) ||
      input.artifact.mode.expectedVersionNo < 0
    ) {
      throw new ArtifactError({
        code: ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
        message: "expectedVersionNo must be a non-negative integer",
        details: "expectedVersionNo",
      });
    }
  } else if (input.artifact.mode.artifactId !== undefined) {
    requireNonEmpty(input.artifact.mode.artifactId, "createArtifactId");
  }
}

export function createCurrentRunArtifactPublicationService(
  dependencies: CurrentRunArtifactPublicationServiceDependencies = {},
) {
  const notify = dependencies.notify ?? publishThreadEvent;
  return {
    publish: async (input: CurrentRunArtifactPublicationInput) => {
      validateInput(input);
      const committed = await commitCurrentRunArtifactPublication(input, {
        ...(dependencies.failpoint
          ? { failpoint: dependencies.failpoint }
          : {}),
        ...(dependencies.newArtifactId
          ? { newArtifactId: dependencies.newArtifactId }
          : {}),
        ...(dependencies.newVersionId
          ? { newVersionId: dependencies.newVersionId }
          : {}),
      });
      if (!committed.ok) {
        return committed;
      }

      // ID-only wake-up after commit. Reconciliation reads the authoritative
      // message/run rows, so transport failure cannot erase or downgrade the
      // committed publication.
      void Promise.resolve()
        .then(() =>
          notify({
            threadId: committed.run.threadId,
            workspaceId: committed.run.workspaceId,
            kind: "artifact_output",
            actorUserId: committed.run.userId,
            runId: committed.run.id,
            status: committed.run.status,
            assistantMessageId: committed.run.assistantMessageId,
          }),
        )
        .catch((error) => {
          logger.warn("Failed to publish current-run artifact output event", {
            runId: committed.run.id,
            artifactId: committed.result.artifactId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return committed;
    },
  };
}

export const currentRunArtifactPublicationService =
  createCurrentRunArtifactPublicationService();

export type { CurrentRunArtifactPublicationServiceDependencies };
