"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import type { AgentToolTrustRule } from "@sourceweft/sdk";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { toast } from "sonner";
import { authClient } from "../../../../lib/auth-client";
import { connectorsClient } from "../../../../lib/sdk";
import { ensureDashboardWorkspace } from "../../../../lib/dashboard-workspace-bootstrap";
import { resolveBillingTeamId } from "./billing-utils";
import { toTrustRuleRow, visibleTrustRules } from "./trust-rules-utils";
import type { BillingOrg } from "./types";

/**
 * Standing approvals ("Always allow") the signed-in user has granted in this
 * workspace, each with a revoke button.
 *
 * This panel is the reason the "Always allow" button is allowed to exist: a
 * grant that outlives the prompt that created it has to be inspectable and
 * withdrawable, or the user has no way back out of a decision they made in one
 * click. Rows are rendered from the server's own identifiers only.
 */
export function TrustRulesPanelContent({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const [rules, setRules] = React.useState<AgentToolTrustRule[]>([]);
  const [loading, setLoading] = React.useState(Boolean(workspaceId));
  const [error, setError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    connectorsClient
      .listAgentToolTrustRules(workspaceId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setRules(visibleTrustRules(response.rules));
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load remembered approvals.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function handleRevoke(ruleId: string) {
    if (!workspaceId) {
      return;
    }
    setRevokingId(ruleId);
    try {
      await connectorsClient.revokeAgentToolTrustRule(workspaceId, ruleId);
      setRules((current) => current.filter((rule) => rule.id !== ruleId));
      toast.success("Approval revoked. You will be asked again next time.");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not revoke approval.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  const rows = rules.map((rule) => toTrustRuleRow(rule));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Approvals</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Actions you chose to always allow in this workspace. Each grant is
          yours alone, expires on its own, and can be revoked here at any time.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading approvals...</p>
      ) : null}

      {!loading && error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}

      {!loading && !error && rows.length === 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No remembered approvals. Every action that needs approval will ask
            you first.
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
              data-testid="trust-rule-row"
              key={row.id}
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {row.toolName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Connector: {row.connectorLabel} · Risk: {row.riskLabel}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Expires: {row.expiryLabel} · Last used: {row.lastUsedLabel}
                </p>
                <p className="truncate text-[11px] text-muted-foreground/80">
                  From confirmation {row.sourceConfirmationLabel}
                </p>
              </div>
              <Button
                className="h-8 shrink-0 px-3 text-xs"
                disabled={revokingId === row.id}
                onClick={() => void handleRevoke(row.id)}
                type="button"
                variant="outline"
              >
                {revokingId === row.id ? "Revoking..." : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Resolves the workspace whose approvals to show. Trust rules are scoped to a
 * workspace on the server, so the panel must never guess: with no workspace it
 * renders the empty state rather than another workspace's grants.
 */
export function TrustRulesPanel() {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const teamId = resolveBillingTeamId({
    activeOrg: activeOrg as BillingOrg | null | undefined,
    orgs: (orgs ?? []) as BillingOrg[],
  });
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!teamId) {
      setWorkspaceId(null);
      return;
    }
    ensureDashboardWorkspace(teamId)
      .then((result) => {
        if (!cancelled) {
          setWorkspaceId(result.active?.id ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return <TrustRulesPanelContent workspaceId={workspaceId} />;
}
