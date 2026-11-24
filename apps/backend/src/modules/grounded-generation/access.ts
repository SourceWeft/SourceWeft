import {
  isGroundedGenerationError,
  type GroundedErrorCode,
} from "@sourceweft/contracts/grounded-generation";
import { findArtifactRecord } from "../artifacts/repository";
import { ContentError } from "../content/errors";
import { findThreadRecord } from "../threads/thread/repository";
import { canViewContent, canViewThread } from "../workspace/content-visibility";
import { requireContentWorkspace } from "../workspace/guards";

const ERROR_STATUS: Record<GroundedErrorCode, number> = {
  SOURCE_NOT_READABLE: 404,
  NO_INDEXED_SOURCES: 409,
  INPUT_TOO_LARGE: 413,
  INSUFFICIENT_CREDITS: 402,
  MODEL_UNAVAILABLE: 503,
  GENERATION_QUALITY_TOO_LOW: 422,
};

/** Grounded generation failures raised while handling a request become API errors. */
export function toGroundedContentError(error: unknown): unknown {
  if (isGroundedGenerationError(error)) {
    return new ContentError(ERROR_STATUS[error.code], error.code, error.message, {
      details: error.details,
    });
  }
  return error;
}

export async function withGroundedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toGroundedContentError(error);
  }
}

/**
 * The workspace the person may use and the thread an artifact will hang off.
 * A thread the person cannot see is "not found".
 */
export async function requireGeneratingThread(input: {
  workspaceId: string;
  userId: string;
  threadId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const thread = await findThreadRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: input.threadId,
  });
  if (!thread || !canViewThread(input.userId, thread)) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }
  return { workspace, thread };
}

/** An artifact of one of `types` that the person may see, or "not found". */
export async function requireViewableArtifact(
  input: { workspaceId: string; userId: string; artifactId: string },
  types: readonly string[],
) {
  const workspace = await requireContentWorkspace(input);
  const artifact = await findArtifactRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    artifactId: input.artifactId,
  });
  if (
    !artifact ||
    !canViewContent(input.userId, artifact) ||
    !types.includes(artifact.artifactType)
  ) {
    throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
  }
  return { workspace, artifact };
}
