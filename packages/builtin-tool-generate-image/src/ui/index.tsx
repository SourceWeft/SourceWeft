/**
 * `generate_image`'s artifact UI, for both surfaces at once.
 *
 * `renderAs: "image"` is the same token this capability already declares in
 * `generateImagePresentation`, so the message-stream block and the tool's
 * presentation stay in sync by construction. `artifactTypes: ["image"]` claims
 * the stored rows this capability writes, so the preview panel needs no payload
 * sniffing on the generic side.
 */
import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import {
  artifactRenderHost,
  type ArtifactBlockProps,
  type ArtifactPreviewContext,
  type ArtifactPreviewResult,
  type ArtifactUiModule,
  type ToolCallView,
} from "@sourceweft/contracts/artifact-ui";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { GeneratedImagePreview } from "./generated-image-preview";
import {
  getGeneratedImageStatus,
  getGeneratedImageTitle,
  resolveGeneratedImageArtifactRef,
} from "./artifact-view";

function GeneratedImageLoadingMask({
  isVisible,
  title,
}: {
  isVisible: boolean;
  title: string;
}) {
  return (
    <div
      aria-hidden={!isVisible}
      aria-label="Generating image"
      className={cn(
        "absolute inset-0 z-10 overflow-hidden rounded-lg transition-opacity duration-500",
        isVisible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      role={isVisible ? "status" : undefined}
    >
      <div className="absolute inset-0 bg-[linear-gradient(145deg,hsl(var(--background))_0%,hsl(var(--muted))_44%,hsl(var(--background))_100%)]" />
      <div className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_18%_18%,hsl(var(--primary)/0.18),transparent_30%),radial-gradient(circle_at_82%_72%,hsl(var(--foreground)/0.10),transparent_30%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(105deg,transparent_0%,hsl(var(--foreground)/0.04)_30%,hsl(var(--foreground)/0.14)_48%,hsl(var(--foreground)/0.05)_66%,transparent_100%)] bg-[length:220%_100%] animate-[image-sheen_2.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(hsl(var(--foreground)/0.08)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.08)_1px,transparent_1px)] [background-size:40px_40px]" />
      <div className="absolute inset-5 rounded-md border border-background/60 bg-background/10 shadow-[inset_0_1px_0_hsl(var(--background)/0.65)]" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background/90 via-background/45 to-transparent" />
      <div className="absolute right-4 bottom-4 left-4">
        <div className="rounded-md border border-border/70 bg-background/80 px-3 py-2 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {title}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Generating image
              </p>
            </div>
            <div className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/70">
              <div className="size-2 rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.55)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneratedImageArtifactItem({
  aspectRatio,
  artifactPageUrl,
  downloadUrl,
  imageFileUrl,
  status,
  title,
}: {
  aspectRatio: string;
  artifactPageUrl?: string | null;
  downloadUrl?: string | null;
  imageFileUrl?: string | null;
  status: ToolCallView["status"];
  title: string;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const isPending = status === "running" || status === "approval_requested";
  const showMask = imageFileUrl ? !isImageLoaded && !hasImageError : isPending;

  useEffect(() => {
    setHasImageError(false);
    setIsImageLoaded(false);
  }, [imageFileUrl]);

  if (!imageFileUrl) {
    return (
      <div
        className="relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted/60"
        style={{ aspectRatio }}
      >
        <GeneratedImageLoadingMask isVisible={isPending} title={title} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted/40",
        isImageLoaded && "bg-transparent",
      )}
      style={{ aspectRatio }}
    >
      <GeneratedImagePreview
        className={cn(
          "size-full transition-opacity duration-200 [&>span]:size-full [&>span]:min-h-0 [&>span]:min-w-0 [&>span>img]:h-full [&>span>img]:w-full [&>span>img]:object-contain",
          isImageLoaded && !hasImageError ? "opacity-100" : "opacity-0",
        )}
        downloadUrl={downloadUrl ?? imageFileUrl}
        imageUrl={imageFileUrl}
        onImageError={() => setHasImageError(true)}
        onImageLoad={() => setIsImageLoaded(true)}
        title={title}
      />
      {hasImageError ? (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-lg border border-border/70 bg-background/90 p-4 text-center shadow-sm">
          <div className="max-w-64">
            <ImageIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              Image preview could not load
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Open or download the artifact to view the generated image.
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {artifactPageUrl ? (
                <a
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={artifactPageUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open
                </a>
              ) : null}
              {downloadUrl ? (
                <a
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={downloadUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Download
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <GeneratedImageLoadingMask isVisible={showMask} title={title} />
    </div>
  );
}

function GeneratedImageArtifactBlock({
  toolCall,
  workspaceId,
}: ArtifactBlockProps) {
  const host = artifactRenderHost();

  if (!toolCall) {
    return null;
  }

  const artifact = resolveGeneratedImageArtifactRef({
    readField: (key) => host.readToolOutputField(toolCall.output, key),
  });
  const artifactPageUrl = artifact
    ? host.resolveArtifactPageUrl({
        artifactId: artifact.artifactId,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const imageFileUrl = artifact
    ? host.resolveArtifactFileUrl({
        artifactId: artifact.artifactId,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const downloadUrl = artifact
    ? host.resolveArtifactFileUrl({
        artifactId: artifact.artifactId,
        download: true,
        fallbackUrl: artifact.artifactUrl,
        workspaceId,
      })
    : null;
  const title =
    artifact?.title || getGeneratedImageTitle(toolCall) || "Generated image";

  const isInFlight =
    toolCall.status === "running" ||
    toolCall.status === "approval_requested" ||
    toolCall.status === "error";
  if (!isInFlight && !imageFileUrl) {
    return null;
  }

  return (
    <div className="space-y-3">
      {toolCall.status === "error" ? (
        <div className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {toolCall.error ?? "Image generation failed."}
        </div>
      ) : (
        <GeneratedImageArtifactItem
          aspectRatio={getGeneratedImageStatus(toolCall).aspectRatio}
          artifactPageUrl={artifactPageUrl}
          downloadUrl={downloadUrl ?? imageFileUrl}
          imageFileUrl={imageFileUrl}
          status={toolCall.status}
          title={title}
        />
      )}
    </div>
  );
}

function generatedImagePreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult | null {
  const { artifact, downloadUrl, proxyFileUrl, title } = context;
  if (artifact.status !== "ready" || !proxyFileUrl) {
    return null;
  }

  return {
    id: "image",
    content: (
      <div className="flex min-h-80 items-center justify-center rounded-xl bg-background p-2">
        <GeneratedImagePreview
          className="w-full [&>span]:mx-auto [&>span]:grid [&>span]:min-h-80 [&>span]:w-full [&>span]:max-w-full [&>span]:place-items-center [&>span>img]:max-h-[calc(100vh-15rem)] [&>span>img]:max-w-full"
          downloadUrl={downloadUrl ?? proxyFileUrl}
          imageUrl={proxyFileUrl}
          title={title}
        />
      </div>
    ),
  };
}

export const generateImageArtifactUi: ArtifactUiModule = {
  id: "generate-image",
  renderAs: "image",
  artifactTypes: ["image"],
  Block: GeneratedImageArtifactBlock,
  preview: generatedImagePreview,
};

export { GeneratedImagePreview } from "./generated-image-preview";
export {
  getGeneratedImagePrompt,
  getGeneratedImageStatus,
  getGeneratedImageTitle,
  parseAspectRatio,
  resolveGeneratedImageArtifactRef,
  type GeneratedImageArtifactRef,
  type GeneratedImageToolCallView,
  type ToolOutputFieldReader,
} from "./artifact-view";
