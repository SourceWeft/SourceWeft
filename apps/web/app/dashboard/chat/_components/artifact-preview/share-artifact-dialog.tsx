"use client";

import * as React from "react";
import { Check, Copy, Eye, Globe, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { ShareLink } from "@sourceweft/contracts";
import { contentClient } from "../../../../../lib/sdk";

/**
 * Publish/unpublish a public link for one artifact. A public link is anonymous,
 * view-only, and served in a sandboxed isolated origin — this dialog is only
 * the on/off switch plus the knobs (search visibility, view count, revoke).
 *
 * Share state lives in the parent (the preview panel fetches it once on mount
 * and renders the "Public" badge from it); the dialog mutates it through
 * `onShareChange` so badge and dialog can never disagree.
 */
export function ShareArtifactDialog({
  open,
  onOpenChange,
  workspaceId,
  artifactId,
  title,
  share,
  isShareLoading,
  onShareChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  artifactId: string;
  title: string;
  share: ShareLink | null;
  isShareLoading: boolean;
  onShareChange: (share: ShareLink | null) => void;
}) {
  const [isBusy, setIsBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function handleToggle(next: boolean) {
    setIsBusy(true);
    try {
      if (next) {
        const result = await contentClient.shareArtifact(
          workspaceId,
          artifactId,
        );
        onShareChange(result.share);
      } else {
        await contentClient.revokeArtifactShare(workspaceId, artifactId);
        onShareChange(null);
      }
    } catch {
      toast.error("Could not change sharing.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleNoindex(noindex: boolean) {
    if (!share) return;
    const previous = share;
    onShareChange({ ...share, noindex });
    try {
      const result = await contentClient.updateArtifactShare(
        workspaceId,
        artifactId,
        { noindex },
      );
      onShareChange(result.share);
    } catch {
      onShareChange(previous);
      toast.error("Could not update search visibility.");
    }
  }

  async function handleCopy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  const isPublic = Boolean(share);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[560px] max-w-[calc(100%-2rem)] gap-5 p-5"
        constrainWidth={false}
      >
        <DialogHeader className="text-left">
          <DialogTitle>Share artifact</DialogTitle>
          <DialogDescription className="truncate">{title}</DialogDescription>
        </DialogHeader>

        {isShareLoading ? (
          <ShareDialogSkeleton />
        ) : (
          <div className="space-y-4">
            <div
              className={cn(
                "flex items-center justify-between gap-4 rounded-xl border p-4 transition-colors",
                isPublic
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "bg-muted/30",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    isPublic
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {isPublic ? (
                    <Globe className="size-4" />
                  ) : (
                    <Lock className="size-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      isPublic && "text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {isPublic ? "Anyone with the link" : "Only your workspace"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {isPublic
                      ? "Public, view-only page on an isolated origin."
                      : "Turn on to publish a public link."}
                  </p>
                </div>
              </div>
              <Switch
                checked={isPublic}
                disabled={isBusy}
                onCheckedChange={(v) => void handleToggle(v)}
              />
            </div>

            {share ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Public link
                  </p>
                  <div className="flex items-stretch overflow-hidden rounded-lg border bg-muted/40 focus-within:ring-2 focus-within:ring-ring/40">
                    <input
                      readOnly
                      value={share.url}
                      className="h-9 min-w-0 flex-1 bg-transparent px-3 text-xs text-foreground outline-none"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      className="h-9 shrink-0 rounded-none border-y-0 border-r-0 border-l"
                      onClick={() => void handleCopy()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {copied ? (
                        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>

                <div className="divide-y rounded-xl border">
                  <label className="flex cursor-pointer items-start justify-between gap-4 p-4">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        Hide from search engines
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        A public link is indexed by default for reach; turn this
                        on for a sensitive one-off.
                      </span>
                    </span>
                    <Switch
                      checked={share.noindex}
                      onCheckedChange={(v) => void handleNoindex(v)}
                    />
                  </label>
                  <div className="flex items-center justify-between gap-4 p-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium">Views</span>
                    </div>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {share.viewCount}
                    </span>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareDialogSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
        <div className="flex items-center gap-3">
          <div className="size-9 animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-52 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="h-5 w-9 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="h-9 animate-pulse rounded-lg bg-muted" />
      <div className="h-20 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
