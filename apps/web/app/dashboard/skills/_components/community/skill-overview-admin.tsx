"use client";

import * as React from "react";
import { Eye, EyeOff, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  getSkillMarketAdminMe,
  getSkillOverviewAdmin,
  regenerateSkillOverview,
  setSkillOverviewHidden,
  type GetSkillOverviewAdminResponse,
} from "../../../../../lib/skill-overviews";
import type { DashboardSkillSlotProps } from "./slot-props";
import { useLocale, useTranslations } from "next-intl";

const LOCALES = ["en", "zh-CN", "zh-TW"] as const;

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

/**
 * A market admin's view of one skill's AI overview (§17.4): each language's
 * state, the model and when it was written, and Regenerate / Hide / Show.
 * Renders nothing for anyone who is not a market admin.
 */
export function SkillOverviewAdmin({ skillId }: DashboardSkillSlotProps) {
  const t = useTranslations("dashboardSkillOverview.admin");
  const locale = useLocale();
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [state, setState] =
    React.useState<GetSkillOverviewAdminResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const viewEpoch = React.useRef(0);
  const requestEpoch = React.useRef(0);
  const load = React.useCallback(async () => {
    const view = viewEpoch.current;
    const request = ++requestEpoch.current;
    const current = () =>
      view === viewEpoch.current && request === requestEpoch.current;
    try {
      const result = await getSkillOverviewAdmin(skillId);
      if (current()) setState(result);
    } catch {
      if (current()) setMessage(t("failed"));
    } finally {
      if (current()) setLoading(false);
    }
  }, [skillId, t]);

  React.useEffect(() => {
    let cancelled = false;
    const epoch = viewEpoch.current;
    setState(null);
    setLoading(true);
    setBusy(false);
    setMessage(null);
    void getSkillMarketAdminMe().then((admin) => {
      if (cancelled) return;
      setIsAdmin(admin);
      if (admin) void load();
    });
    return () => {
      cancelled = true;
      viewEpoch.current = epoch + 1;
    };
  }, [load]);

  React.useEffect(() => {
    if (
      !isAdmin ||
      !["pending", "running"].includes(state?.analysis?.status ?? "")
    )
      return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [isAdmin, state?.analysis?.status, load]);

  if (!isAdmin) return null;

  async function run(action: () => Promise<string>) {
    const view = viewEpoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const done = await action();
      if (view !== viewEpoch.current) return;
      await load();
      if (view === viewEpoch.current) setMessage(done);
    } catch {
      if (view === viewEpoch.current) setMessage(t("failed"));
    } finally {
      if (view === viewEpoch.current) setBusy(false);
    }
  }

  const rows = new Map(
    (state?.overviews ?? []).map((entry) => [entry.locale, entry]),
  );
  const first = state?.overviews[0];
  const allHidden =
    (state?.overviews.length ?? 0) > 0 &&
    state!.overviews.every((entry) => entry.hidden);

  return (
    <section
      aria-label={t("title")}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        {busy || loading ? (
          <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {loading && !state ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("loading")}</p>
      ) : state ? (
        <div className="mt-3 space-y-3 text-xs">
          <div className="space-y-1" data-testid="analysis-state">
            <p>
              {t("analysisState")}:{" "}
              {t(
                `analysisStatuses.${state.analysis?.status ?? (state.overviews.length ? "legacy" : "missing")}`,
              )}
            </p>
            <p>
              {t("categorySource")}:{" "}
              {t(`categorySources.${state.categoriesSource ?? "none"}`)}
            </p>
            {state.analysis?.classification ? (
              <>
                <p>
                  {t("rationale")}: {state.analysis.classification.rationale}
                </p>
                <p>
                  {t("evidence")}:{" "}
                  {state.analysis.classification.evidence.join(" · ")}
                </p>
              </>
            ) : null}
            {state.analysis?.error ? (
              <p role="alert">{state.analysis.error}</p>
            ) : null}
            <p className="text-muted-foreground">{t("retained")}</p>
          </div>
          {!state.skillVersionId ? (
            <p className="text-muted-foreground">{t("noVersion")}</p>
          ) : !state.eligible ? (
            <p className="text-muted-foreground">{t("notEligible")}</p>
          ) : state.overviews.length === 0 ? (
            <p className="text-muted-foreground">{t("none")}</p>
          ) : null}

          {state.overviews.length > 0 ? (
            <>
              <ul className="space-y-1" aria-label={t("title")}>
                {LOCALES.map((locale) => {
                  const row = rows.get(locale);
                  return (
                    <li
                      key={locale}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="font-mono">{locale}</span>
                      <Badge
                        variant={row && !row.hidden ? "secondary" : "outline"}
                      >
                        {!row
                          ? t("missing")
                          : row.hidden
                            ? t("hidden")
                            : t("visible")}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
              {first ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
                  <dt>{t("model")}</dt>
                  <dd className="truncate text-foreground" title={first.model}>
                    {first.model}
                  </dd>
                  <dt>{t("generatedAt")}</dt>
                  <dd className="text-foreground">
                    {formatDate(first.generatedAt, locale)}
                  </dd>
                </dl>
              ) : null}
            </>
          ) : null}

          {state.skillVersionId ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  !state.eligible ||
                  state.analysis?.status === "pending" ||
                  state.analysis?.status === "running"
                }
                onClick={() =>
                  void run(async () => {
                    const result = await regenerateSkillOverview(skillId);
                    return result.queued
                      ? t("regenerateQueued")
                      : t("regenerateNotQueued");
                  })
                }
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t("regenerate")}
              </Button>
              {state.overviews.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await setSkillOverviewHidden(skillId, !allHidden);
                      return allHidden ? t("shownDone") : t("hiddenDone");
                    })
                  }
                >
                  {allHidden ? (
                    <Eye className="size-3.5" aria-hidden />
                  ) : (
                    <EyeOff className="size-3.5" aria-hidden />
                  )}
                  {allHidden ? t("show") : t("hide")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
