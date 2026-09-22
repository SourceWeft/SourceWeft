"use client";

import * as React from "react";
import { Loader2, Save, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import type { Workspace } from "@sourceweft/contracts";
import { authClient } from "../../../../../lib/auth-client";
import { workspaceClient } from "../../../../../lib/sdk";
import {
  getSkillAnalysisPreview,
  queueSkillAnalysisBatch,
  type SkillAnalysisPreviewResponse,
  getSkillOverviewBilling,
  getSkillOverviewStatus,
  setSkillOverviewBilling,
  type GetSkillOverviewBillingResponse,
  type SkillOverviewStatusResponse,
} from "../../../../../lib/skill-overviews";
import { useLocale, useTranslations } from "next-intl";

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";

export type SettingsTeam = { id: string; name: string };

type WorkspaceOption = Pick<Workspace, "id" | "name" | "organizationId">;

/** The request the form sends; a blank member bills the admin saving it. */
export function overviewBillingRequest(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  const userId = input.userId.trim();
  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    ...(userId ? { userId } : {}),
  };
}

function errorMessage(error: unknown, fallback: string) {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : fallback;
}

// Stable across renders: the workspace list reloads when the team changes,
// not on every render.
async function listTeamWorkspaces(teamId: string): Promise<WorkspaceOption[]> {
  return (await workspaceClient.listWorkspaces(teamId)).items;
}

/**
 * The overview-billing form and coverage counts. Teams come in as props (the
 * admin's own); workspaces are listed for the chosen team, so the team is
 * always the workspace's own.
 */
export function OverviewBillingSettings({
  teams,
  loadWorkspaces = listTeamWorkspaces,
}: {
  teams: SettingsTeam[];
  loadWorkspaces?: (teamId: string) => Promise<WorkspaceOption[]>;
}) {
  const t = useTranslations("dashboardSkillOverview.settings");
  const locale = useLocale();
  const [current, setCurrent] =
    React.useState<GetSkillOverviewBillingResponse | null>(null);
  const [status, setStatus] =
    React.useState<SkillOverviewStatusResponse | null>(null);
  const [teamId, setTeamId] = React.useState("");
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [userId, setUserId] = React.useState("");
  const [workspaces, setWorkspaces] = React.useState<WorkspaceOption[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getSkillOverviewBilling(), getSkillOverviewStatus()])
      .then(([billing, counts]) => {
        if (cancelled) return;
        setCurrent(billing);
        setStatus(counts);
        if (billing.billing) {
          setTeamId(billing.billing.teamId);
          setWorkspaceId(billing.billing.workspaceId);
        }
      })
      .catch(() => {
        if (!cancelled) setMessage(t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  React.useEffect(() => {
    if (!teamId) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    loadWorkspaces(teamId)
      .then((items) => {
        if (!cancelled) setWorkspaces(items);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, loadWorkspaces]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!teamId || !workspaceId) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await setSkillOverviewBilling(
        overviewBillingRequest({ teamId, workspaceId, userId }),
      );
      setCurrent(next);
      setUserId("");
      setMessage(t("saved"));
      setStatus(await getSkillOverviewStatus().catch(() => status));
    } catch (error) {
      setMessage(errorMessage(error, t("failed")));
    } finally {
      setSaving(false);
    }
  }

  const billing = current?.billing ?? null;
  const teamName = (id: string) =>
    teams.find((team) => team.id === id)?.name ?? id;
  const workspaceName = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? id;
  // A saved workspace from another team still shows in its select.
  const workspaceOptions =
    workspaceId && !workspaces.some((w) => w.id === workspaceId)
      ? [
          ...workspaces,
          { id: workspaceId, name: workspaceId, organizationId: teamId },
        ]
      : workspaces;
  const teamOptions =
    teamId && !teams.some((team) => team.id === teamId)
      ? [...teams, { id: teamId, name: teamId }]
      : teams;

  const counts: Array<[string, React.ReactNode]> = status
    ? [
        [t("eligible"), status.eligible],
        [t("withOverview"), status.withOverview],
        [t("missingCount"), status.missing],
        [t("hiddenCount"), status.hidden],
        [t("billingSet"), status.billingConfigured ? t("yes") : t("no")],
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

      <div className="text-xs" data-testid="overview-billing-current">
        <span className="text-muted-foreground">{t("current")}</span>
        {billing ? (
          <span className="text-foreground">
            {teamName(billing.teamId)} / {workspaceName(billing.workspaceId)} /{" "}
            <span className="font-mono">{billing.userId}</span>
            {current?.updatedBy ? (
              <span className="text-muted-foreground">
                {" "}
                {t.rich("updatedByNote", {
                  userId: current.updatedBy,
                  hasDate: current.updatedAt ? "yes" : "no",
                  date: current.updatedAt
                    ? new Date(current.updatedAt).toLocaleString(locale)
                    : "",
                  who: (chunks) => <span className="font-mono">{chunks}</span>,
                })}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("notSet")}</span>
        )}
      </div>

      <form
        className="grid max-w-md gap-3 text-xs"
        onSubmit={(e) => void save(e)}
      >
        <label className="grid gap-1">
          <span className="text-muted-foreground">{t("team")}</span>
          <select
            aria-label={t("team")}
            className={selectClass}
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setWorkspaceId("");
            }}
          >
            <option value="">{t("choose")}</option>
            {teamOptions.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">{t("workspace")}</span>
          <select
            aria-label={t("workspace")}
            className={selectClass}
            disabled={!teamId}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">{t("choose")}</option>
            {workspaceOptions.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">{t("member")}</span>
          <Input
            aria-label={t("member")}
            className="h-8 text-xs"
            placeholder={billing?.userId ?? ""}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
          <span className="text-muted-foreground">{t("memberHint")}</span>
        </label>
        <div>
          <Button
            size="sm"
            type="submit"
            disabled={saving || !teamId || !workspaceId}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </form>

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
            className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5"
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

/** Market settings, e.g. who AI overviews are billed to (§17.4). */
export function SkillMarketSettingsAdmin() {
  const { data } = authClient.useListOrganizations();
  const teams = React.useMemo(
    () =>
      ((data ?? []) as Array<{ id: string; name: string }>).map((team) => ({
        id: team.id,
        name: team.name,
      })),
    [data],
  );
  return <OverviewBillingSettings teams={teams} />;
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
