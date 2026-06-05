import { ArtifactPreviewPageClient } from "./artifact-preview-page-client";

type ArtifactPreviewSearchParams = {
  artifactId?: string | string[];
  workspaceId?: string | string[];
};

function firstValue(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ArtifactPreviewPage({
  searchParams,
}: {
  searchParams: Promise<ArtifactPreviewSearchParams>;
}) {
  const params = await searchParams;
  return (
    <ArtifactPreviewPageClient
      artifactId={firstValue(params.artifactId) ?? null}
      workspaceId={firstValue(params.workspaceId) ?? null}
    />
  );
}
