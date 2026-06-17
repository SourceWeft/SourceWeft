export type VideoPresentationStatus = "pending" | "running" | "ready";

export function buildVideoPresentationToolResult(input: {
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly durationSeconds?: number;
  readonly fileName: string;
  readonly jobId?: string;
  readonly narrationEnabled: boolean;
  readonly reused?: boolean;
  readonly status?: VideoPresentationStatus;
  readonly title: string;
  readonly versionId?: string;
}): Record<string, unknown> {
  const status = input.status ?? "pending";
  return {
    type: "video_presentation_artifact_result",
    artifact_id: input.artifactId,
    artifact_url: input.artifactUrl,
    content:
      status === "ready"
        ? `Video presentation project ready: ${input.fileName}\nThe application can preview it and export the final video in the browser.`
        : `Video presentation project queued: ${input.fileName}\nThe application is preparing the scene spec and narration assets in the background.`,
    ...(typeof input.durationSeconds === "number"
      ? { duration_seconds: input.durationSeconds }
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
