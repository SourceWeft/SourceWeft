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

export function buildArtifactDownloadUrl(input: {
  readonly artifactId: string;
  readonly workspaceId: string;
}): string {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    download: "1",
    workspaceId: input.workspaceId,
  });
  return `/api/artifact-file?${params.toString()}`;
}

export function buildArtifactPreviewImageUrl(input: {
  readonly artifactId: string;
  readonly workspaceId: string;
}): string {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    workspaceId: input.workspaceId,
  });
  params.set("asset", "previewImage");
  return `/api/artifact-file?${params.toString()}`;
}
