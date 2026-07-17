import type { ReactNode } from "react";
import type { ArtifactListItem } from "../sources-hub/types";

export type ArtifactPreviewLayout = "page" | "panel";

export type ArtifactPreviewContext = {
  artifact: ArtifactListItem;
  downloadUrl: string | null;
  layout: ArtifactPreviewLayout;
  pageUrl: string | null;
  payload: Record<string, unknown>;
  proxyFileUrl: string | null;
  title: string;
  workspaceId?: string | null;
};

export type ArtifactPreviewRenderer = {
  blocksDefaultDownload?: boolean;
  blocksDefaultOpen?: boolean;
  id: string;
  match: (context: ArtifactPreviewContext) => boolean;
  render: (context: ArtifactPreviewContext) => ReactNode;
};
