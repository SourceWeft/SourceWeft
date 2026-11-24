import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
  ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
import { STUDY_ARTIFACT_TYPES } from "@sourceweft/contracts/study";
import { StudyArtifactView } from "./study-artifact-view";

function studyPreview(context: ArtifactPreviewContext): ArtifactPreviewResult {
  return {
    id: "study",
    // Exports (Anki CSV, Markdown, JSON) live in the viewers; there is no stored file.
    blocksDefaultDownload: true,
    content: (
      <StudyArtifactView
        artifact={context.artifact}
        // The public share page never records learning state.
        interactive={context.surface === "share" ? false : undefined}
        payload={context.payload}
        title={context.title}
      />
    ),
  };
}

export const studyArtifactUi: ArtifactUiModule = {
  id: "study",
  artifactTypes: STUDY_ARTIFACT_TYPES,
  preview: studyPreview,
};

export { StudyArtifactView } from "./study-artifact-view";
export { FlashcardsViewer } from "./flashcards/flashcards-viewer";
export { QuizViewer } from "./quiz/quiz-viewer";
export { MindmapViewer } from "./mindmap/mindmap-viewer";
export { EvidencePopover, StaleBanner } from "@sourceweft/grounded-generation/ui";
export { StudyCannotDisplay, StudyErrorBoundary } from "./shared/error-boundary";
export {
  configureStudyHost,
  readOnlyStudyHost,
  STUDY_TRANSLATION_KEYS,
  StudyHostProvider,
  useStudyHost,
  type QuizAttemptView,
  type ReviewStateView,
  type StudyFreshness,
  type StudyHost,
  type StudyTranslate,
  type StudyVersionRef,
} from "./study-host";
