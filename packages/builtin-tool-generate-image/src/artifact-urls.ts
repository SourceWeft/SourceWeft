export function buildArtifactPreviewUrl(input: {
  readonly artifactId: string;
  readonly workspaceId: string;
}): string {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  return `/artifact-preview?${params.toString()}`;
}

export function buildPptxArtifactUrl(input: {
  readonly artifactId: string;
  readonly workspaceId: string;
}): string {
  return buildArtifactPreviewUrl(input);
}

export function buildSourceJsonArtifactUrl(input: {
  readonly artifactId: string;
  readonly workspaceId: string;
}): string {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/source.json`;
}
