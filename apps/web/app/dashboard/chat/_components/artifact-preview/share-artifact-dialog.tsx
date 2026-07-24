"use client";

import * as React from "react";
import { Check, Copy, Eye, Globe, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import type { ShareLink } from "@sourceweft/contracts";
import { contentClient } from "../../../../../lib/sdk";

/**
 * Publish/unpublish a public link for one artifact. A public link is anonymous,
 * view-only, and served in a sandboxed isolated origin — this dialog is only
 * the on/off switch plus the knobs (search visibility, view count, revoke).
 */
export function ShareArtifactDialog({
  open,
  onOpenChange,
  workspaceId,
  artifactId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  artifactId: string;
  title: string;
}) {
  const [share, setShare] = React.useState<ShareLink | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    contentClient
      .getArtifactShare(workspaceId, artifactId)
      .then((result) => {
        if (!cancelled) setShare(result.share);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load share status.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, artifactId]);

  async function handleToggle(next: boolean) {
    setIsBusy(true);
    try {
      if (next) {
        const result = await contentClient.shareArtifact(
          workspaceId,
          artifactId,
        );
        setShare(result.share);
      } else {
        await contentClient.revokeArtifactShare(workspaceId, artifactId);
        setShare(null);
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
    setShare({ ...share, noindex });
    try {
      const result = await contentClient.updateArtifactShare(
        workspaceId,
        artifactId,
        { noindex },
      );
      setShare(result.share);
    } catch {
      setShare(previous);
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
      <DialogContent className="gap-4">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{title}”</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex items-center gap-2.5">
                {isPublic ? (
                  <Globe className="size-4 text-foreground" />
                ) : (
                  <Lock className="size-4 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">
                    {isPublic ? "Anyone with the link" : "Only your workspace"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isPublic
                      ? "Public, view-only page"
                      : "Turn on to publish a public link"}
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
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={share.url}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-muted/40 px-3 text-xs text-muted-foreground"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    onClick={() => void handleCopy()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {copied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>

                <label className="flex cursor-pointer items-start justify-between gap-3 text-sm">
                  <span>
                    <span className="font-medium">
                      Hide from search engines
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      A public link is indexed by default for reach; turn this
                      on for a sensitive one-off.
                    </span>
                  </span>
                  <Switch
                    checked={share.noindex}
                    onCheckedChange={(v) => void handleNoindex(v)}
                  />
                </label>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Eye className="size-3.5" />
                  {share.viewCount} {share.viewCount === 1 ? "view" : "views"}
                </div>
              </div>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
