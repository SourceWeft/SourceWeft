"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ResearchRun } from "@sourceweft/contracts/source-research";
import { Button } from "@sourceweft/ui-web/components/ui/button";

export function ResearchCard({
  onCancel,
  run,
}: {
  onCancel: () => void | Promise<void>;
  run: ResearchRun;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const active = run.status === "queued" || run.status === "running";
  return (
    <div className="rounded-md border p-3 text-sm" data-testid="research-card">
      <p className="font-medium break-words">{run.topic}</p>
      {active ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            <span>
              {t(`research.phase.${run.phase}`)}
              {" · "}
              {t("research.progress", {
                searches: run.progress.searches,
                pages: run.progress.pagesRead,
              })}
            </span>
          </div>
          <Button
            onClick={() => void onCancel()}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("research.cancel")}
          </Button>
        </div>
      ) : null}
      {run.status === "cancelled" ? (
        <p className="text-muted-foreground mt-2">{t("research.cancelled")}</p>
      ) : null}
      {run.status === "failed" ? (
        <p className="text-destructive mt-2 flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(`research.error.${run.errorCode ?? "UNKNOWN"}`)}</span>
        </p>
      ) : null}
    </div>
  );
}
