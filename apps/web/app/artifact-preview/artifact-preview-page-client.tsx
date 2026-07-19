"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../lib/sdk";
// Imported directly rather than through the sources-hub barrel, which would
// pull the entire hub component into this page's bundle for one panel.
import { ArtifactPreviewPanel } from "../dashboard/chat/_components/artifact-preview/artifact-preview-panel";
import type { ArtifactListItem } from "../dashboard/chat/_components/sources-hub/types";

const VIDEO_PRESENTATION_POLL_INTERVAL_MS = 3000;
const VIDEO_PRESENTATION_MAX_CONSECUTIVE_POLL_FAILURES = 3;

type LoadState =
  | { artifact: ArtifactListItem; error?: never; status: "ready" }
  | { artifact?: never; error: string; status: "error" }
  | { artifact?: never; error?: never; status: "loading" };

function shouldPollArtifact(artifact: ArtifactListItem) {
  return (
    artifact.artifactType === "video_presentation" &&
    (artifact.status === "pending" || artifact.status === "running")
  );
}

export function ArtifactPreviewPageClient({
  artifactId,
  workspaceId,
}: {
  artifactId: string | null;
  workspaceId: string | null;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [pollFailureCount, setPollFailureCount] = useState(0);
  const canLoad = Boolean(artifactId && workspaceId);

  useEffect(() => {
    let cancelled = false;

    async function loadArtifact() {
      if (!artifactId || !workspaceId) {
        setState({
          error: "Missing workspaceId or artifactId.",
          status: "error",
        });
        return;
      }

      setState({ status: "loading" });
      setPollFailureCount(0);
      try {
        const result = await contentClient.getArtifact(workspaceId, artifactId);
        if (!cancelled) {
          setState({ artifact: result.artifact, status: "ready" });
          setPollFailureCount(0);
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            error:
              error instanceof Error
                ? error.message
                : "Could not load this artifact.",
            status: "error",
          });
        }
      }
    }

    void loadArtifact();
    return () => {
      cancelled = true;
    };
  }, [artifactId, workspaceId]);

  useEffect(() => {
    if (
      !artifactId ||
      !workspaceId ||
      state.status !== "ready" ||
      !shouldPollArtifact(state.artifact)
    ) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      void contentClient
        .getArtifact(workspaceId, artifactId)
        .then((result) => {
          if (cancelled) {
            return;
          }

          setPollFailureCount(0);
          setState({ artifact: result.artifact, status: "ready" });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          setPollFailureCount((current) => {
            const next = current + 1;
            if (next >= VIDEO_PRESENTATION_MAX_CONSECUTIVE_POLL_FAILURES) {
              setState({
                error:
                  error instanceof Error
                    ? error.message
                    : "Could not refresh this video presentation status.",
                status: "error",
              });
            }
            return next;
          });
        });
    }, VIDEO_PRESENTATION_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [artifactId, state, workspaceId]);

  const handleClose = useCallback(() => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.assign(
      workspaceId
        ? `/dashboard/chat?workspaceId=${encodeURIComponent(workspaceId)}`
        : "/dashboard/chat",
    );
  }, [workspaceId]);

  const content = useMemo(() => {
    if (!canLoad || state.status === "error") {
      return (
        <div className="grid h-full place-items-center bg-muted/10 p-6">
          <div className="w-full max-w-md rounded-lg border bg-background p-5 text-center shadow-sm">
            <AlertCircle className="mx-auto mb-3 size-5 text-destructive" />
            <h1 className="text-sm font-semibold text-foreground">
              Artifact preview is unavailable
            </h1>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {state.status === "error"
                ? state.error
                : "Missing workspaceId or artifactId."}
            </p>
            <Button asChild className="mt-4" size="sm" variant="outline">
              <Link href="/dashboard/chat">
                <ArrowLeft className="size-3.5" />
                Back to chat
              </Link>
            </Button>
          </div>
        </div>
      );
    }

    if (state.status === "loading") {
      return (
        <div className="grid h-full place-items-center bg-muted/10">
          <div className="flex items-center gap-2 rounded-full border bg-background px-4 py-2 text-xs text-muted-foreground shadow-sm">
            <Loader2 className="size-3.5 animate-spin" />
            Loading artifact preview
          </div>
        </div>
      );
    }

    return (
      <ArtifactPreviewPanel
        artifact={state.artifact}
        className="mx-auto h-full w-full max-w-7xl border-x"
        layout="page"
        onClose={handleClose}
        workspaceId={workspaceId}
      />
    );
  }, [canLoad, handleClose, state, workspaceId]);

  return (
    <main className="h-svh min-h-0 overflow-hidden bg-background text-foreground">
      {content}
    </main>
  );
}
