import { buildArtifactPreviewUrl } from "./artifact-urls";
import { compactVideoPresentationSourceText } from "./video-presentation-files";

export function buildVideoPresentationInitialPayload(input: {
  readonly artifactId: string;
  readonly fileName: string;
  readonly jobId: string;
  readonly narrationEnabled: boolean;
  readonly requestKey: string;
  readonly sourceContent: string;
  readonly title: string;
  readonly userPrompt?: string;
  readonly workspaceId: string;
}): Record<string, unknown> {
  return {
    title: input.title,
    prompt:
      input.userPrompt ??
      compactVideoPresentationSourceText(input.sourceContent),
    artifactKind: "video_presentation",
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    fileName: input.fileName,
    jobId: input.jobId,
    requestKey: input.requestKey,
    generation: {
      status: "pending",
      stage: "planning",
    },
    narrationEnabled: input.narrationEnabled,
    source: {
      contentPreview: compactVideoPresentationSourceText(
        input.sourceContent,
        1200,
      ),
      userPrompt: input.userPrompt,
    },
    artifactUrl: buildArtifactPreviewUrl({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    }),
  };
}
