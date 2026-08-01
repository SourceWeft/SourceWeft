import { Loader2, Presentation, RotateCcw, Sparkles } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@sourceweft/ui-web/components/ui/button";
import { RawImage } from "../../../../../_components/raw-image";
import {
  artifactMatchesQuery,
  artifactPreviewImageMetadata,
  artifactTitle,
  artifactTypeLabel,
  resolveArtifactPreviewImageProxyUrl,
  resolveArtifactProxyFileUrl,
} from "../artifacts";
import { HubEmptyState } from "../components/hub-empty-state";
import { memoComponent } from "../memo-component";
import { TypeBadge } from "../type-badge";
import type { ArtifactListItem } from "../types";

export const ArtifactsTab = memoComponent(function ArtifactsTab({
  artifacts,
  hasMore,
  isLoading,
  isLoadingMore,
  loadingError,
  onLoadMore,
  onPreview,
  onRefresh,
  searchQuery,
  workspaceId,
}: {
  artifacts: ArtifactListItem[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadingError: string | null;
  onLoadMore: () => void;
  onPreview: (artifact: ArtifactListItem) => void;
  onRefresh: () => void;
  searchQuery: string;
  workspaceId?: string | null;
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? artifacts.filter((artifact) => artifactMatchesQuery(artifact, q))
        : artifacts,
    [artifacts, q],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading artifacts...
      </div>
    );
  }

  if (loadingError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">{loadingError}</p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="xs"
          type="button"
          variant="outline"
        >
          <RotateCcw className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="space-y-2">
        <HubEmptyState
          description={
            searchQuery
              ? "Try a different title, artifact type, or prompt."
              : "Reports, slides, images, tables, audio briefs, and other finished deliverables will appear here."
          }
          icon={Sparkles}
          title={
            searchQuery
              ? `No artifacts match "${searchQuery}"`
              : "Finished artifacts will appear here."
          }
        />
        {hasMore && searchQuery ? (
          <Button
            className="w-full"
            disabled={isLoadingMore}
            onClick={onLoadMore}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLoadingMore ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Load more
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map((artifact) => {
        const proxyFileUrl = resolveArtifactProxyFileUrl({
          artifact,
          workspaceId,
        });
        const previewImage = artifactPreviewImageMetadata(artifact);
        const previewImageUrl = resolveArtifactPreviewImageProxyUrl({
          artifact,
          workspaceId,
        });

        return (
          <button
            className="group relative isolate flex w-full items-start gap-3 rounded-lg border border-border/70 bg-background p-2.5 text-left shadow-xs outline-none transition-[background-color,border-color,box-shadow] hover:border-foreground/25 hover:bg-accent/35 hover:shadow-sm hover:shadow-foreground/5 focus-visible:border-primary/45 focus-visible:bg-accent/30 focus-visible:shadow-[0_8px_24px_-18px_hsl(var(--foreground)/0.45),0_0_0_1px_hsl(var(--primary)/0.18)] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:rounded-[inherit] focus-visible:after:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.55)] focus-visible:after:content-['']"
            key={artifact.id}
            onClick={() => onPreview(artifact)}
            title={`Preview ${artifactTitle(artifact)}`}
            type="button"
          >
            {previewImageUrl ? (
              <span className="block h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                <RawImage
                  alt={previewImage?.altText ?? artifactTitle(artifact)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={previewImageUrl}
                />
              </span>
            ) : artifact.artifactType === "image" && proxyFileUrl ? (
              <span className="block h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                <RawImage
                  alt={artifactTitle(artifact)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={proxyFileUrl}
                />
              </span>
            ) : artifact.artifactType === "slides" ? (
              <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                <Presentation className="size-4 text-muted-foreground" />
              </div>
            ) : (
              <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                <Sparkles className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium text-foreground underline-offset-2 group-hover:underline">
                  {artifactTitle(artifact)}
                </span>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{new Date(artifact.createdAt).toLocaleString()}</span>
                {artifact.completedAt ? (
                  <span>
                    completed {new Date(artifact.completedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <TypeBadge label={artifactTypeLabel(artifact.artifactType)} />
                <TypeBadge label={artifact.status} />
                {artifact.isPublic ? (
                  <TypeBadge label="Public" tone="public" />
                ) : null}
              </div>
              {artifact.promptText ? (
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {artifact.promptText}
                </p>
              ) : null}
            </div>
          </button>
        );
      })}
      {hasMore ? (
        <Button
          className="w-full"
          disabled={isLoadingMore}
          onClick={onLoadMore}
          size="sm"
          type="button"
          variant="outline"
        >
          {isLoadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
});
