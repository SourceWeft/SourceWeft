import type { Metadata } from "next";

import { NO_INDEX_METADATA } from "../seo";
import { ArtifactPreviewPageClient } from "./artifact-preview-page-client";

// Authenticated in-app surface, not a landing page.
export const metadata: Metadata = NO_INDEX_METADATA;

type ArtifactPreviewSearchParams = {
  artifactId?: string | string[];
  artifactVersionId?: string | string[];
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
      artifactVersionId={firstValue(params.artifactVersionId) ?? null}
      workspaceId={firstValue(params.workspaceId) ?? null}
    />
  );
}
