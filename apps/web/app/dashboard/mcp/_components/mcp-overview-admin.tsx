"use client";

import * as React from "react";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  getMarketAdminMe,
  getMcpOverviewAdmin,
  MCP_OVERVIEW_LOCALES,
  regenerateMcpOverview,
  setMcpOverviewHidden,
  type McpOverviewAdminState,
} from "../../../../lib/mcp-ai-overview";

const ANALYSIS_STATUSES: readonly string[] = [
  "pending",
  "running",
  "ready",
  "failed",
  "needs-review",
];
const CATEGORY_SOURCES: readonly string[] = ["auto", "ai", "admin"];

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function isRunning(state: McpOverviewAdminState | null) {
  const status = state?.analysis?.status;
  return status === "pending" || status === "running";
}

/**
 * A market admin's view of one MCP server's AI overview: each language's
 * state, the latest analysis and its error, whether the system model can
 * write overviews, the model and when it wrote them, and Regenerate / Hide /
 * Show. Renders nothing for anyone who is not a market admin.
 */
export function McpOverviewAdmin({ identifier }: { identifier: string }) {
  const t = useTranslations("mcp.aiOverview.admin");
  const locale = useLocale();
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [state, setState] = React.useState<McpOverviewAdminState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  // A server change (or unmount) moves the view on; a newer load supersedes
  // an older one. Late answers from either are dropped.
  const viewEpoch = React.useRef(0);
  const requestEpoch = React.useRef(0);
  const load = React.useCallback(async () => {
    const view = viewEpoch.current;
    const request = ++requestEpoch.current;
    const current = () =>
      view === viewEpoch.current && request === requestEpoch.current;
    try {
      const result = await getMcpOverviewAdmin(identifier);
      if (current()) setState(result);
    } catch {
      if (current()) setMessage(t("failed"));
    } finally {
      if (current()) setLoading(false);
    }
  }, [identifier, t]);

  React.useEffect(() => {
    let cancelled = false;
    const epoch = viewEpoch.current;
    setState(null);
    setLoading(true);
    setBusy(false);
    setMessage(null);
    void getMarketAdminMe().then((admin) => {
      if (cancelled) return;
      setIsAdmin(admin);
      if (admin) void load();
    });
    return () => {
      cancelled = true;
      viewEpoch.current = epoch + 1;
    };
  }, [load]);

  const running = isRunning(state);
  React.useEffect(() => {
    if (!isAdmin || !running) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [isAdmin, running, load]);

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

  const entries = state?.entries ?? [];
  const rows = new Map(entries.map((entry) => [entry.locale, entry]));
  const first = entries[0];
  const allHidden =
    entries.length > 0 && entries.every((entry) => entry.hidden);
  const status = state?.analysis?.status ?? "";
  const source = state?.categoriesSource ?? null;

  return (
    <section
      aria-label={t("title")}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
      data-testid="mcp-overview-admin"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        {busy || loading ? (
          <Loader2
            className="ml-auto size-3.5 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </div>

      {loading && !state ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("loading")}</p>
      ) : state ? (
        <div className="mt-3 space-y-3 text-xs">
          <div className="space-y-1" data-testid="mcp-overview-analysis">
            <p>
              {t("analysisState")}:{" "}
              {!state.analysis
                ? t("analysisStatuses.missing")
                : ANALYSIS_STATUSES.includes(status)
                  ? t(`analysisStatuses.${status}`)
                  : status}
            </p>
            <p>
              {t("categorySource")}:{" "}
              {!source
                ? t("categorySources.none")
                : CATEGORY_SOURCES.includes(source)
                  ? t(`categorySources.${source}`)
                  : source}
            </p>
            {state.analysis?.error ? (
              <p className="text-destructive" role="alert">
                {state.analysis.error}
              </p>
            ) : null}
            <p className="text-muted-foreground">{t("retained")}</p>
          </div>

          {state.systemModel ? (
            <div
              className="space-y-0.5"
              data-testid="mcp-overview-system-model"
            >
              <p className="flex items-center gap-1.5">
                {state.systemModel.ready ? (
                  <CheckCircle2
                    className="size-3.5 text-foreground"
                    aria-hidden
                  />
                ) : (
                  <CircleAlert
                    className="size-3.5 text-destructive"
                    aria-hidden
                  />
                )}
                <span className="font-medium text-foreground">
                  {t("systemModel")}
                </span>
                <span
                  className={
                    state.systemModel.ready
                      ? "text-foreground"
                      : "text-destructive"
                  }
                >
                  {state.systemModel.ready
                    ? t("systemModelReady")
                    : t("systemModelNotReady")}
                </span>
              </p>
              {!state.systemModel.ready && state.systemModel.reason ? (
                <p className="text-muted-foreground">
                  {state.systemModel.reason}
                </p>
              ) : null}
            </div>
          ) : null}

          {!state.eligible ? (
            <p className="text-muted-foreground">{t("notEligible")}</p>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground">{t("none")}</p>
          ) : null}

          {entries.length > 0 ? (
            <>
              <ul aria-label={t("locales")} className="space-y-1">
                {MCP_OVERVIEW_LOCALES.map((id) => {
                  const row = rows.get(id);
                  return (
                    <li
                      className="flex items-center justify-between gap-2"
                      key={id}
                    >
                      <span className="font-mono">{id}</span>
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

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !state.eligible || running}
              onClick={() =>
                void run(async () => {
                  const { queued } = await regenerateMcpOverview(identifier);
                  return queued === false
                    ? t("regenerateNotQueued")
                    : t("regenerateQueued");
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {t("regenerate")}
            </Button>
            {entries.length > 0 ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await setMcpOverviewHidden(identifier, !allHidden);
                    return allHidden ? t("shownDone") : t("hiddenDone");
                  })
                }
                size="sm"
                type="button"
                variant="outline"
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
        </div>
      ) : null}

      {message ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
