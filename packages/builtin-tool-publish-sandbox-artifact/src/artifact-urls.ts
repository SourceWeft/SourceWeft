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
