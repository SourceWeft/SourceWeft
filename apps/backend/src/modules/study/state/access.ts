import {
  parseStudyContentForArtifact,
  type StudyArtifactType,
  type StudyContent,
} from "@sourceweft/contracts/study";
import { ContentError } from "../../content/errors";
import { workspaceService } from "../../workspace";
import { canViewContent } from "../../workspace/content-visibility";
import { findReadyStudyArtifactVersion, type StudyOwner } from "./repository";

export type AuthorizedStudyVersion<K extends StudyArtifactType> = {
  /** Team and workspace come from the artifact row, never from the request. */
  owner: StudyOwner;
  threadId: string | null;
  title: string | null;
  versionId: string;
  versionNo: number;
  content: Extract<StudyContent, { kind: K }>;
};

export function notFound(): ContentError {
  return new ContentError(404, "STUDY_ARTIFACT_NOT_FOUND", "Artifact not found");
}

/** 404 for every unavailable case, so callers without access learn nothing. */
export async function requireWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
}) {
  const access = await workspaceService.resolveAccess(input);
  if (!access || access.role === null) throw notFound();
  return access;
}

/**
 * Loads one version of a study artifact the caller may view. The artifact must
 * sit in the workspace named by the route; a missing, foreign, private or
 * non-ready artifact, a wrong type and an unknown version all look alike.
 */
export async function requireStudyVersion<K extends StudyArtifactType>(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  artifactType: K;
  versionNo?: number;
  /** Alternative to `versionNo`: the version id a client holds. */
  artifactVersionId?: string;
}): Promise<AuthorizedStudyVersion<K>> {
  const access = await requireWorkspaceMember(input);
  const row = await findReadyStudyArtifactVersion({
    teamId: access.organizationId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    versionNo: input.versionNo,
    artifactVersionId: input.artifactVersionId,
  });
  if (
    !row ||
    row.artifactType !== input.artifactType ||
    !canViewContent(input.userId, row)
  ) {
    throw notFound();
  }
  let content: StudyContent;
  try {
    content = parseStudyContentForArtifact(row.artifactType, row.contentJson);
  } catch {
    throw new ContentError(
      422,
      "STUDY_CONTENT_INVALID",
      "This study artifact's content cannot be read",
    );
  }
  return {
    owner: {
      userId: input.userId,
      teamId: row.teamId,
      workspaceId: row.workspaceId,
      artifactId: row.artifactId,
    },
    threadId: row.threadId,
    title: row.title,
    versionId: row.versionId,
    versionNo: row.versionNo,
    content: content as Extract<StudyContent, { kind: K }>,
  };
}
