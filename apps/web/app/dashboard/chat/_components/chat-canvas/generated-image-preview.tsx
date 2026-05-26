import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Download,
  FlipHorizontal,
  FlipVertical,
  ImageIcon,
  Maximize2,
  Minimize2,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { RawImage } from "../../../../_components/raw-image";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function downloadFilename(title: string) {
  const normalized = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 96);

  return `${normalized || "generated-image"}.png`;
}

function PreviewToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="bg-background/70 text-foreground shadow-sm backdrop-blur hover:bg-muted"
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          title={label}
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ImageLoadingPlaceholder({
  className,
  title,
}: {
  className?: string;
  title: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-border/60 bg-muted/50",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[linear-gradient(145deg,hsl(var(--muted))_0%,hsl(var(--background))_48%,hsl(var(--muted))_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(105deg,transparent_0%,hsl(var(--foreground)/0.04)_30%,hsl(var(--foreground)/0.12)_48%,hsl(var(--foreground)/0.04)_66%,transparent_100%)] bg-[length:220%_100%] animate-[image-sheen_2.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(hsl(var(--foreground)/0.07)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.07)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className="flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-background/75 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <ImageIcon className="size-4 shrink-0" />
          <span className="truncate">Loading {title}</span>
        </div>
      </div>
    </div>
  );
}

export function GeneratedImagePreview({
  className,
  downloadUrl,
  imageUrl,
  onImageLoad,
  title,
}: {
  className?: string;
  downloadUrl?: string | null;
  imageUrl: string;
  onImageLoad?: () => void;
  title: string;
}) {
  const [fitToScreen, setFitToScreen] = useState(true);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [open, setOpen] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const previewDialogRef = useRef<HTMLDivElement>(null);

  const imageStyle = useMemo<CSSProperties>(
    () => ({
      transform: `rotate(${rotation}deg) scale(${flipX ? -scale : scale}, ${
        flipY ? -scale : scale
      })`,
    }),
    [flipX, flipY, rotation, scale],
  );

  const resetTransform = useCallback(() => {
    setFitToScreen(true);
    setFlipX(false);
    setFlipY(false);
    setRotation(0);
    setScale(1);
  }, []);

  useEffect(() => {
    setPreviewLoaded(false);
  }, [imageUrl]);

  const handlePreviewLoad = useCallback(() => {
    setPreviewLoaded(true);
    onImageLoad?.();
  }, [onImageLoad]);

  const handleDownload = useCallback(async () => {
    const targetUrl = downloadUrl || imageUrl;

    try {
      const response = await fetch(targetUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Download failed with ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = downloadFilename(title);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch {
      const link = document.createElement("a");
      link.href = targetUrl;
      link.download = downloadFilename(title);
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.info("Opening image download.");
    }
  }, [downloadUrl, imageUrl, title]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          aria-label={`Preview ${title}`}
          className={cn(
            "group block w-fit max-w-full cursor-zoom-in rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            className,
          )}
          type="button"
        >
          <span className="relative block min-h-48 min-w-64 max-w-full overflow-hidden rounded-lg bg-muted/40">
            <ImageLoadingPlaceholder
              className={cn(
                "transition-opacity duration-200",
                previewLoaded ? "opacity-0" : "opacity-100",
              )}
              title={title}
            />
            <RawImage
              alt={title}
              className={cn(
                "max-h-[520px] max-w-full rounded-lg object-contain transition duration-150 group-hover:shadow-md",
                previewLoaded ? "opacity-100" : "opacity-0",
              )}
              loading="lazy"
              onLoad={handlePreviewLoad}
              src={imageUrl}
            />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        className="w-auto max-w-[calc(100vw-1rem)] gap-0 border-0 bg-transparent p-0 text-foreground ring-0 shadow-none sm:max-w-[calc(100vw-2rem)]"
        constrainWidth={false}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          previewDialogRef.current?.focus({ preventScroll: true });
        }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div
          className="flex max-h-[calc(100dvh-1rem)] flex-col items-center justify-center gap-3 outline-none sm:max-h-[calc(100dvh-2rem)]"
          ref={previewDialogRef}
          tabIndex={-1}
        >
          <div className="max-h-[calc(100dvh-5.75rem)] max-w-[calc(100vw-1rem)] overflow-auto rounded-lg sm:max-h-[calc(100dvh-6.5rem)] sm:max-w-[calc(100vw-2rem)]">
            <div className="flex min-h-full min-w-full items-center justify-center">
              <RawImage
                alt={title}
                className={cn(
                  "h-auto w-auto select-none rounded-lg bg-background/20 shadow-2xl transition-transform duration-150",
                  fitToScreen
                    ? "max-h-[calc(100dvh-5.75rem)] max-w-[calc(100vw-1rem)] object-contain sm:max-h-[calc(100dvh-6.5rem)] sm:max-w-[calc(100vw-2rem)]"
                    : "max-h-none max-w-none",
                )}
                draggable={false}
                src={imageUrl}
                style={imageStyle}
              />
            </div>
          </div>
          <div className="flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto rounded-full border border-border/50 bg-background/85 p-1.5 shadow-2xl backdrop-blur-md sm:max-w-[calc(100vw-2rem)]">
            <PreviewToolbarButton
              disabled={scale <= MIN_SCALE}
              label="Zoom out"
              onClick={() => {
                setFitToScreen(true);
                setScale((value) => clampScale(value - SCALE_STEP));
              }}
            >
              <ZoomOut className="size-4" />
            </PreviewToolbarButton>
            <span className="hidden min-w-12 text-center text-xs tabular-nums text-muted-foreground sm:inline">
              {Math.round(scale * 100)}%
            </span>
            <PreviewToolbarButton
              disabled={scale >= MAX_SCALE}
              label="Zoom in"
              onClick={() => {
                setFitToScreen(true);
                setScale((value) => clampScale(value + SCALE_STEP));
              }}
            >
              <ZoomIn className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton
              label={fitToScreen ? "Actual size" : "Fit to screen"}
              onClick={() => {
                setScale(1);
                setFitToScreen((value) => !value);
              }}
            >
              {fitToScreen ? (
                <Maximize2 className="size-4" />
              ) : (
                <Minimize2 className="size-4" />
              )}
            </PreviewToolbarButton>
            <PreviewToolbarButton
              label="Rotate left"
              onClick={() => setRotation((value) => value - 90)}
            >
              <RotateCcw className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton
              label="Rotate right"
              onClick={() => setRotation((value) => value + 90)}
            >
              <RotateCw className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton
              label="Flip horizontally"
              onClick={() => setFlipX((value) => !value)}
            >
              <FlipHorizontal className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton
              label="Flip vertically"
              onClick={() => setFlipY((value) => !value)}
            >
              <FlipVertical className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton label="Reset" onClick={resetTransform}>
              <RefreshCcw className="size-4" />
            </PreviewToolbarButton>
            <PreviewToolbarButton label="Download" onClick={handleDownload}>
              <Download className="size-4" />
            </PreviewToolbarButton>
            <DialogClose asChild>
              <Button
                aria-label="Close preview"
                className="bg-background/70 text-foreground shadow-sm backdrop-blur hover:bg-muted"
                size="icon-sm"
                title="Close preview"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
