import type {
  ArtifactViewHandler,
  ArtifactViewRecord,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import {
  STUDY_ARTIFACT_TYPES,
  parseStudyContentForArtifact,
  type StudyArtifactType,
} from "@sourceweft/contracts/study";
import { downloadStem } from "./ui/shared/util";

/**
 * Read-side takeover for flashcards, quizzes and mind maps.
 *
 * Study artifacts are rendered client-side from their content JSON: there is no
 * stored file, no media and no sub-asset, so deleting one leaves no storage
 * object behind. Registering the handler is what tells the host the type
 * renders client-side.
 */

function parseContent(artifactType: StudyArtifactType, artifact: ArtifactViewRecord) {
  try {
    return parseStudyContentForArtifact(artifactType, artifact.payloadJson);
  } catch {
    return null;
  }
}

function studyArtifactViewHandler(
  artifactType: StudyArtifactType,
): ArtifactViewHandler {
  return {
    artifactType,
    listOwnedStorageObjects: () => [],
    buildSourceJson: ({ artifact }) => {
      const content = parseContent(artifactType, artifact);
      return content
        ? {
            payload: content as unknown as Record<string, unknown>,
            fileName: `${downloadStem(artifact.title, "study")}.${artifactType}.json`,
          }
        : null;
    },
  };
}

export const studyArtifactViewHandlers: readonly ArtifactViewHandler[] =
  STUDY_ARTIFACT_TYPES.map(studyArtifactViewHandler);

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () =>
  studyArtifactViewHandlers;
