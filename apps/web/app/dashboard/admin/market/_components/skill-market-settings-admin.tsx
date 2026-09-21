"use client";

import * as React from "react";
import { Loader2, Save, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import type { Workspace } from "@sourceweft/contracts";
import { authClient } from "../../../../../lib/auth-client";
import { workspaceClient } from "../../../../../lib/sdk";
import {
  getSkillOverviewBilling,
  getSkillOverviewStatus,
  setSkillOverviewBilling,
  type GetSkillOverviewBillingResponse,
  type SkillOverviewStatusResponse,
} from "../../../../../lib/skill-overviews";
import { skillOverviewCopy } from "../../../skills/_components/community/skill-overview-copy";

const copy = skillOverviewCopy.settings;

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
        if (!cancelled) setMessage(copy.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setMessage(copy.saved);
      setStatus(await getSkillOverviewStatus().catch(() => status));
    } catch (error) {
      setMessage(errorMessage(error, copy.failed));
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
        [copy.eligible, status.eligible],
        [copy.withOverview, status.withOverview],
        [copy.missingCount, status.missing],
        [copy.hiddenCount, status.hidden],
        [copy.billingSet, status.billingConfigured ? copy.yes : copy.no],
      ]
    : [];

  return (
    <section
      aria-label={copy.title}
      className="space-y-4 rounded-2xl border border-border bg-background p-4 shadow-xs"
    >
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">
            {copy.title}
          </h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{copy.description}</p>
      </div>

      <div className="text-xs" data-testid="overview-billing-current">
        <span className="text-muted-foreground">{copy.current}: </span>
        {billing ? (
          <span className="text-foreground">
            {teamName(billing.teamId)} / {workspaceName(billing.workspaceId)} /{" "}
            <span className="font-mono">{billing.userId}</span>
            {current?.updatedBy ? (
              <span className="text-muted-foreground">
                {" "}
                ({copy.updatedBy}{" "}
                <span className="font-mono">{current.updatedBy}</span>
                {current.updatedAt
                  ? `, ${new Date(current.updatedAt).toLocaleString()}`
                  : ""}
                )
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">{copy.notSet}</span>
        )}
      </div>

      <form
        className="grid max-w-md gap-3 text-xs"
        onSubmit={(e) => void save(e)}
      >
        <label className="grid gap-1">
          <span className="text-muted-foreground">{copy.team}</span>
          <select
            aria-label={copy.team}
            className={selectClass}
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setWorkspaceId("");
            }}
          >
            <option value="">{copy.choose}</option>
            {teamOptions.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">{copy.workspace}</span>
          <select
            aria-label={copy.workspace}
            className={selectClass}
            disabled={!teamId}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">{copy.choose}</option>
            {workspaceOptions.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">{copy.member}</span>
          <Input
            aria-label={copy.member}
            className="h-8 text-xs"
            placeholder={billing?.userId ?? ""}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
          <span className="text-muted-foreground">{copy.memberHint}</span>
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
            {saving ? copy.saving : copy.save}
          </Button>
        </div>
      </form>

      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}

      {counts.length > 0 ? (
        <div>
          <h3 className="text-xs font-medium text-foreground">{copy.status}</h3>
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
