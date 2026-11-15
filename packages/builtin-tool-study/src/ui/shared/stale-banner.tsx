"use client";

import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  useStudyHost,
  type StudyFreshness,
  type StudyVersionRef,
} from "../study-host";

/**
 * Says when an input source changed (or was deleted) since generation. It
 * never regenerates by itself — that costs credits — it only offers the
 * host's regenerate action when there is one.
 */
export function StaleBanner({ version }: { version: StudyVersionRef }) {
  const host = useStudyHost();
  const t = host.useTranslate();
  const [freshness, setFreshness] = useState<StudyFreshness["status"]>("unknown");
  const { workspaceId, artifactId, artifactVersionId } = version;

  useEffect(() => {
    if (!host.interactive) return;
    let cancelled = false;
    host
      .getFreshness({ workspaceId, artifactId, artifactVersionId })
      .then((result) => {
        if (!cancelled) setFreshness(result.status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifactId, artifactVersionId, host, workspaceId]);

  if (freshness !== "stale" && freshness !== "source_deleted") return null;
  const regenerate = host.requestRegenerate;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
      role="status"
    >
      <TriangleAlert aria-hidden className="size-4 text-amber-600" />
      <span className="min-w-0 flex-1">
        {t(
          freshness === "stale"
            ? "study.stale.message"
            : "study.stale.sourceDeleted",
        )}
      </span>
      {freshness === "stale" && regenerate ? (
        <Button
          onClick={() => regenerate({ workspaceId, artifactId, artifactVersionId })}
          size="xs"
          type="button"
          variant="outline"
        >
          <RefreshCw aria-hidden />
          {t("study.stale.regenerate")}
        </Button>
      ) : null}
    </div>
  );
}
