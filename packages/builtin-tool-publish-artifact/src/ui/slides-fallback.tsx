"use client";

/**
 * The "nothing to render inline" card for a published deck.
 *
 * Worded for this capability (a `.pptx` the browser cannot always draw), so it
 * lives here rather than beside the host's generic artifact fallbacks.
 */
import { Sparkles } from "lucide-react";

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
