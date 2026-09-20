"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

export function PendingArtifactPreview({
  detail,
  title,
}: {
  detail?: string;
  title?: string;
}) {
  const t = useTranslations("dashboardChatFiles");
  return (
    <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">
          {title ?? t("fallback.pendingTitle")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {detail ?? t("fallback.pendingDetail")}
        </p>
      </div>
    </div>
  );
}

export function FailedArtifactPreview({
  message,
}: {
  message?: string | null;
}) {
  const t = useTranslations("dashboardChatFiles");
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
      <p className="text-sm font-medium text-destructive">
        {t("fallback.failedTitle")}
      </p>
      <p className="mt-2 text-xs leading-5 text-destructive/80">
        {message || t("errors.noDetails")}
      </p>
    </div>
  );
}

export function UnsupportedArtifactPreview() {
  const t = useTranslations("dashboardChatFiles");
  return (
    <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-background/70 px-5 text-center">
      <div>
        <Sparkles className="mx-auto mb-3 size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t("fallback.unsupportedTitle")}
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {t("fallback.unsupportedDetail")}
        </p>
      </div>
    </div>
  );
}
