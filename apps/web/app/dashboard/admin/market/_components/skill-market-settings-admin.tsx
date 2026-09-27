"use client";

import * as React from "react";
import { CheckCircle2, CircleAlert, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  getSkillAnalysisPreview,
  queueSkillAnalysisBatch,
  type SkillAnalysisPreviewResponse,
  getSkillOverviewStatus,
  type SkillOverviewStatusResponse,
} from "../../../../../lib/skill-overviews";
import { useTranslations } from "next-intl";

function errorMessage(error: unknown, fallback: string) {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : fallback;
}

/**
 * Whether the system model can write overviews and, when it cannot, exactly
 * what is missing. It is configured by the deployment's SYSTEM_MODEL_*
 * settings, not here; its calls are billed to no team.
 */
function SystemModelStatus({
  systemModel,
}: {
  systemModel: SkillOverviewStatusResponse["systemModel"];
}) {
  const t = useTranslations("dashboardSkillOverview.settings");
  return (
    <div className="space-y-1 text-xs" data-testid="system-model-status">
      <div className="flex items-center gap-2">
        {systemModel.ready ? (
          <CheckCircle2 className="size-3.5 text-foreground" aria-hidden />
        ) : (
          <CircleAlert className="size-3.5 text-destructive" aria-hidden />
        )}
        <span className="font-medium text-foreground">{t("systemModel")}</span>
        <span
          className={systemModel.ready ? "text-foreground" : "text-destructive"}
        >
          {systemModel.ready ? t("systemModelReady") : t("systemModelNotReady")}
        </span>
      </div>
      <p className="text-muted-foreground">
        {systemModel.provider && systemModel.model
          ? t("systemModelTarget", {
              provider: systemModel.provider,
              model: systemModel.model,
            })
          : t("systemModelUnset")}
      </p>
      {!systemModel.ready && systemModel.problems.length > 0 ? (
        <ul
          aria-label={t("systemModelProblems")}
          className="list-disc space-y-0.5 pl-5 text-muted-foreground"
        >
          {systemModel.problems.map((problem) => (
            <li key={problem}>
              {t(`problems.${problem}`, {
                provider: systemModel.provider ?? "",
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * AI overview settings: whether the system model can write them, the
 * analysis batch, and coverage counts.
 */
export function SkillOverviewSettings() {
  const t = useTranslations("dashboardSkillOverview.settings");
  const [status, setStatus] =
    React.useState<SkillOverviewStatusResponse | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    getSkillOverviewStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setMessage(t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const counts: Array<[string, React.ReactNode]> = status
    ? [
        [t("eligible"), status.eligible],
        [t("withOverview"), status.withOverview],
        [t("missingCount"), status.missing],
        [t("hiddenCount"), status.hidden],
      ]
    : [];

  return (
    <section
      aria-label={t("title")}
      className="space-y-4 rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">
            {t("title")}
          </h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {status ? <SystemModelStatus systemModel={status.systemModel} /> : null}

      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}

      <SkillAnalysisBatchPreview />

      {counts.length > 0 ? (
        <div>
          <h3 className="text-xs font-medium text-foreground">{t("status")}</h3>
          <dl
            className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"
            data-testid="overview-status"
          >
            {counts.map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-sm font-semibold text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}

/** Market settings: AI overviews and their system model (§17.4). */
export function SkillMarketSettingsAdmin() {
  return <SkillOverviewSettings />;
}

/** Preview each bounded batch before explicitly scheduling paid analysis. */
export function SkillAnalysisBatchPreview() {
  const t = useTranslations("dashboardSkillOverview.settings");
  const a = useTranslations("dashboardSkillOverview.admin");
  const [preview, setPreview] =
    React.useState<SkillAnalysisPreviewResponse | null>(null);
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const requestEpoch = React.useRef(0);
  React.useEffect(
    () => () => {
      requestEpoch.current++;
    },
    [],
  );
  const eligible =
    preview?.items.filter(
      (item) =>
        item.categoriesSource !== "admin" &&
        item.status !== "pending" &&
        item.status !== "running" &&
        (item.stale ||
          item.status === "failed" ||
          item.status === "missing" ||
          item.status === "legacy" ||
          item.status === "needs-review"),
    ) ?? [];

  async function load(next?: string) {
    const epoch = ++requestEpoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await getSkillAnalysisPreview(next);
      if (epoch !== requestEpoch.current) return;
      setPreview(result);
      setCursor(next);
    } catch (error) {
      if (epoch === requestEpoch.current)
        setMessage(errorMessage(error, t("loadFailed")));
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  }

  async function queue() {
    const epoch = ++requestEpoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await queueSkillAnalysisBatch(
        eligible.map((item) => item.skillVersionId),
      );
      const updated = await getSkillAnalysisPreview(cursor);
      if (epoch !== requestEpoch.current) return;
      setMessage(t("batchQueued", result));
      setPreview(updated);
    } catch (error) {
      if (epoch === requestEpoch.current)
        setMessage(errorMessage(error, t("failed")));
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  }

  React.useEffect(() => {
    if (
      !preview?.items.some(
        (item) => item.status === "pending" || item.status === "running",
      )
    )
      return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      const epoch = requestEpoch.current;
      void getSkillAnalysisPreview(cursor)
        .then((result) => {
          if (!cancelled && epoch === requestEpoch.current) setPreview(result);
        })
        .catch(() => {
          if (!cancelled && epoch === requestEpoch.current)
            setMessage(t("loadFailed"));
        });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [preview, cursor, t]);

  return (
    <div className="space-y-3 border-t border-border pt-4 text-xs">
      <h3 className="font-medium">{t("batchTitle")}</h3>
      <p className="text-muted-foreground">{t("batchDescription")}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void load()}
      >
        {t("previewBatch")}
      </Button>
      {preview ? (
        <>
          {preview.items.length === 0 ? (
            <p>{t("batchEmpty")}</p>
          ) : (
            <ul className="space-y-2" aria-label={t("batchTitle")}>
              {preview.items.map((item) => (
                <li
                  key={item.skillVersionId}
                  className="space-y-1 rounded-md border border-border p-2"
                >
                  <p className="font-medium">
                    {item.name} · {a(`analysisStatuses.${item.status}`)}
                    {item.stale ? ` · ${t("stale")}` : ""}
                  </p>
                  <p>
                    {a("categorySource")}:{" "}
                    {a(`categorySources.${item.categoriesSource ?? "none"}`)}
                  </p>
                  <p>
                    {t("currentCategories")}:{" "}
                    {item.categories.join(", ") || t("noCategories")}
                  </p>
                  <p>
                    {t("suggestedCategories")}:{" "}
                    {item.suggestedCategories.join(", ") || t("noSuggestion")}
                  </p>
                  {item.error ? <p role="alert">{item.error}</p> : null}
                </li>
              ))}
            </ul>
          )}
          {!preview.qualityApproved ? <p>{t("qualityGate")}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                busy || eligible.length === 0 || !preview.qualityApproved
              }
              onClick={() => void queue()}
            >
              {t("generateBatch", { count: eligible.length })}
            </Button>
            {preview.nextCursor ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void load(preview.nextCursor!)}
              >
                {t("nextBatch")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
