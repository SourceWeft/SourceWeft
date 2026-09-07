import type { AgentToolAuthorizedArtifactVersion } from "@sourceweft/contracts/agent-tools";
import { artifactTypeSchema } from "@sourceweft/contracts/artifacts";
import { workspaceService } from "../workspace";
import { canViewContent } from "../workspace/content-visibility";
import {
  findArtifactRecord,
  findCurrentReadyArtifactVersionRecord,
} from "./repository";

/** Actor identity comes from the host; unavailable and private rows look alike. */
export async function readAuthorizedArtifactRecord(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}) {
  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!access || access.role === null) return null;
  const artifact = await findArtifactRecord({
    teamId: access.organizationId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
  });
  return artifact && canViewContent(input.userId, artifact) ? artifact : null;
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Application authorization boundary for an Agent tool loading an artifact.
 *
 * Actor/team/workspace identity is host-owned. Access is deliberately resolved
 * for every invocation rather than inherited from turn preparation, so revoked
 * membership stops subsequent reads. Every unavailable case returns `null` to
 * keep wrong type, non-ready state, missing version, and private rows
 * indistinguishable to an unauthorized caller.
 */
export async function readAuthorizedCurrentArtifactVersion(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  expectedArtifactType: string;
}): Promise<AgentToolAuthorizedArtifactVersion | null> {
  const expectedArtifactType = artifactTypeSchema.safeParse(
    input.expectedArtifactType,
  );
  if (!expectedArtifactType.success) {
    return null;
  }

  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!access || access.role === null) {
    return null;
  }

  const current = await findCurrentReadyArtifactVersionRecord({
    teamId: access.organizationId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    expectedArtifactType: expectedArtifactType.data,
  });
  if (!current || !canViewContent(input.userId, current)) {
    return null;
  }

  const payload = objectPayload(current.contentJson);
  if (!payload) {
    return null;
  }

  return {
    artifactId: current.artifactId,
    versionId: current.versionId,
    versionNo: current.versionNo,
    payload,
  };
}
