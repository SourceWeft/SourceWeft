import { Loader2, Sparkles } from "lucide-react";

export function PendingArtifactPreview({
  detail = "Preview will be available when the artifact is ready.",
  title = "Artifact is still generating",
}: {
  detail?: string;
  title?: string;
}) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function FailedArtifactPreview({ message }: { message?: string | null }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
      <p className="text-sm font-medium text-destructive">
        Artifact generation failed
      </p>
      <p className="mt-2 text-xs leading-5 text-destructive/80">
        {message || "No error details were saved."}
      </p>
    </div>
  );
}

export function UnsupportedArtifactPreview() {
  return (
    <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <div>
        <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          Preview is not available
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          This artifact can still be opened or downloaded from the toolbar when
          a file is available.
        </p>
      </div>
    </div>
  );
}

export function SlidesFallback({
  detail,
  title,
}: {
  detail?: string;
  title?: string;
}) {
  return (
    <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <div>
        <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {title ?? "PPTX artifact is ready"}
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {detail ??
            "Open it in a new tab or download the artifact from the toolbar."}
        </p>
      </div>
    </div>
  );
}
