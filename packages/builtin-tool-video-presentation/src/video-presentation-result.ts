export type VideoPresentationStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed";

export function buildVideoPresentationInputRequiredResult(
  input: {
    readonly message?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: "presentation_artifact_input_required",
    status: "needs_content",
    content:
      input.message ??
      "Tell me what the video presentation should be about, and I can generate it.",
    message:
      input.message ??
      "A short video presentation brief is required before generation can start.",
  };
}

export function buildVideoPresentationProcessingResult(input: {
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly fileName: string;
  readonly jobId?: string;
  readonly narrationEnabled: boolean;
  readonly sourceJsonUrl?: string;
  readonly stage?: string;
  readonly title: string;
}): Record<string, unknown> {
  return {
    type: "video_presentation_processing_result",
    artifact_id: input.artifactId,
    artifact_url: input.artifactUrl,
    ...(input.sourceJsonUrl ? { source_json_url: input.sourceJsonUrl } : {}),
    content: `Video presentation project is still being generated: ${input.fileName}\nThe background worker is still building scene code and narration assets.\nDo NOT call generate_video_presentation again for this request — the same artifact keeps building in the background and a retry would duplicate it. Tell the user generation is in progress and the artifact will become previewable when ready.`,
    file_name: input.fileName,
    ...(input.jobId ? { job_id: input.jobId } : {}),
    narration_enabled: input.narrationEnabled,
    render_strategy: "frontend_remotion_project_to_video",
    ...(input.stage ? { stage: input.stage } : {}),
    status: "running",
    title: input.title,
    video_download_only: true,
  };
}

export function buildVideoPresentationToolResult(input: {
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly durationSeconds?: number;
  readonly errorMessage?: string;
  readonly fileName: string;
  readonly jobId?: string;
  readonly narrationEnabled: boolean;
  readonly reused?: boolean;
  readonly sourceJsonUrl?: string;
  readonly status?: VideoPresentationStatus;
  readonly title: string;
  readonly versionId?: string;
}): Record<string, unknown> {
  const status = input.status ?? "pending";
  return {
    type: "video_presentation_artifact_result",
    artifact_id: input.artifactId,
    artifact_url: input.artifactUrl,
    ...(input.sourceJsonUrl ? { source_json_url: input.sourceJsonUrl } : {}),
    content:
      status === "ready"
        ? `Video presentation project ready: ${input.fileName}\nThe application can preview it and export the final video in the browser.`
        : status === "failed"
          ? `Video presentation project failed: ${input.fileName}\nOpen the artifact to review the generation error.`
          : `Video presentation project is still being generated: ${input.fileName}\nThe background worker is generating scene code and narration assets.`,
    ...(typeof input.durationSeconds === "number"
      ? { duration_seconds: input.durationSeconds }
      : {}),
    ...(status === "failed" && input.errorMessage
      ? { error: input.errorMessage }
      : {}),
    file_name: input.fileName,
    ...(input.jobId ? { job_id: input.jobId } : {}),
    narration_enabled: input.narrationEnabled,
    render_strategy: "frontend_remotion_project_to_video",
    ...(input.reused ? { reused: true } : {}),
    status,
    title: input.title,
    ...(input.versionId ? { version_id: input.versionId } : {}),
    video_download_only: true,
  };
}
