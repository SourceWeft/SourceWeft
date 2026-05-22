"use client";

import * as React from "react";
import { Check, ChevronDown, MailPlus, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../../lib/auth-client";
import { TeamCheckoutDialog } from "../../../_components/team-checkout-dialog";
import { getPricingConfig } from "../../../_landing/pricing-config";
import {
  getPersonalOrganization,
  getVisibleTeamOrganizations,
  isPersonalOrganization,
} from "../dashboard-team-selector-shared";
import { TeamPanelSkeleton } from "../dashboard-settings-center-modal-skeleton";
import type { BillingOrg, BillingScope } from "./types";

export function TeamPanel({
  onScopeChange,
}: {
  hasTeam: boolean;
  scope: BillingScope;
  onScopeChange: (scope: BillingScope) => void;
  teamName?: string;
}) {
  const { data: orgs, refetch: refetchOrganizations } =
    authClient.useListOrganizations();
  const { data: activeOrg, refetch: refetchActiveOrganization } =
    authClient.useActiveOrganization();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"admin" | "member">(
    "member",
  );
  const [isInviting, setIsInviting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = React.useState<string | null>(
    null,
  );

  const refreshTeamData = React.useCallback(async () => {
    await Promise.all([
      refetchActiveOrganization().catch(() => null),
      refetchOrganizations().catch(() => null),
    ]);
  }, [refetchActiveOrganization, refetchOrganizations]);

  React.useEffect(() => {
    void refreshTeamData();
  }, [refreshTeamData]);

  React.useEffect(() => {
    function handleWindowFocus() {
      void refreshTeamData();
    }

    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [refreshTeamData]);

  React.useEffect(() => {
    const intervalId = window.setInterval(() => void refreshTeamData(), 30000);
    return () => window.clearInterval(intervalId);
  }, [refreshTeamData]);

  async function handleSwitch(org: BillingOrg) {
    try {
      await authClient.organization.setActive({
        organizationId: org.id,
        fetchOptions: { throw: true },
      });
      await refreshTeamData();
      setSwitcherOpen(false);
      onScopeChange(isPersonalOrganization(org) ? "personal" : "team");
    } catch {
      toast.error("Failed to switch team.");
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteError(null);
    if (!activeOrgFull || isPersonalOrganization(activeOrgFull)) {
      setInviteError("Personal team cannot invite members.");
      return;
    }
    setIsInviting(true);
    try {
      const result = (await authClient.organization.inviteMember({
        email,
        role: inviteRole,
        organizationId: activeOrgFull.id,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to send invite.");
      await refreshTeamData();
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      toast.success(`Invitation sent to ${email}`);
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : "Failed to send invitation.",
      );
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRevoke(invitationId: string) {
    setRevokingId(invitationId);
    try {
      const result = (await authClient.organization.cancelInvitation({
        invitationId,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to revoke invitation.");
      await refreshTeamData();
      toast.success("Invitation revoked.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRemoveMember(member: {
    id: string;
    role: string;
    user: { email: string; name: string };
  }) {
    setRemovingMemberId(member.id);
    try {
      const result = (await authClient.organization.removeMember({
        memberIdOrEmail: member.id,
        organizationId: activeOrgFull?.id,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to remove member.");
      await refreshTeamData();
      toast.success(`${member.user.name || member.user.email} removed.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove member.",
      );
    } finally {
      setRemovingMemberId(null);
    }
  }

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const personalOrg = getPersonalOrganization((orgs ?? []) as BillingOrg[]);
  const activeOrgFull = activeOrg as
    | {
        id: string;
        metadata?: unknown;
        name: string;
        members: Array<{
          id: string;
          role: string;
          user: { name: string; email: string };
        }>;
        invitations: Array<{
          id: string;
          email: string;
          role: string;
          status: string;
        }>;
      }
    | null
    | undefined;
  const isPersonalActive =
    !activeOrgFull || isPersonalOrganization(activeOrgFull);
  const canManageMembers = Boolean(activeOrgFull && !isPersonalActive);
  const manageableOrg = canManageMembers ? activeOrgFull : null;

  const memberEmails = new Set(
    manageableOrg?.members
      ?.map((member) => member.user.email.toLowerCase())
      .filter(Boolean) ?? [],
  );
  const pendingInvites = manageableOrg
    ? (manageableOrg.invitations?.filter(
        (inv) =>
          inv.status === "pending" &&
          !memberEmails.has(inv.email.toLowerCase()),
      ) ?? [])
    : [];
  const teamPlan = getPricingConfig().find((plan) => plan.id === "team");
  const monthlyTeamSeatPrice = teamPlan?.monthlyPrice ?? 0;
  const yearlyTeamSeatPrice = teamPlan?.yearlyPrice ?? 0;
  const loadingTeamData = orgs === undefined || activeOrg === undefined;

  if (loadingTeamData) {
    return <TeamPanelSkeleton />;
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Team ── */}
      <div className="pb-7 pt-1">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-base font-semibold text-foreground">Team</p>
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            Create team
          </Button>
        </div>

        {/* Switcher trigger */}
        <Popover onOpenChange={setSwitcherOpen} open={switcherOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50"
              type="button"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-foreground">
                  {isPersonalActive
                    ? "P"
                    : activeOrgFull
                      ? activeOrgFull.name.slice(0, 2).toUpperCase()
                      : "P"}
                </div>
                <span className="truncate text-sm text-foreground">
                  {isPersonalActive
                    ? (personalOrg?.name ?? activeOrgFull?.name)
                    : activeOrgFull?.name}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[260px] p-1.5">
            {personalOrg ? (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  isPersonalActive && "bg-accent/60",
                )}
                onClick={() => void handleSwitch(personalOrg)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  P
                </div>
                <span className="flex-1 truncate">{personalOrg.name}</span>
                {isPersonalActive && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                )}
              </button>
            ) : null}
            {orgList.length > 0 && (
              <>
                <div className="my-1 border-t border-border/60" />
                {orgList.map((org) => (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      activeOrgFull?.id === org.id && "bg-accent/60",
                    )}
                    key={org.id}
                    onClick={() => void handleSwitch(org)}
                    type="button"
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                      {org.name.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="flex-1 truncate">{org.name}</span>
                    {activeOrgFull?.id === org.id && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    )}
                  </button>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* ── Members (only when a team is active) ── */}
      {manageableOrg ? (
        <>
          <div className="py-7">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-foreground">Members</p>
              <Button
                onClick={() => setInviteOpen(true)}
                size="sm"
                type="button"
              >
                <MailPlus className="h-3.5 w-3.5" />
                Invite
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              {manageableOrg.members?.length ? (
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="hidden px-4 py-2.5 text-left text-xs font-medium text-muted-foreground sm:table-cell">
                        Email
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Role
                      </th>
                      <th className="w-10 px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {manageableOrg.members.map((m) => (
                      <tr key={m.id}>
                        <td className="px-4 py-2.5 font-medium text-foreground">
                          {m.user.name}
                        </td>
                        <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                          {m.user.email}
                        </td>
                        <td className="px-4 py-2.5 capitalize text-muted-foreground">
                          {m.role}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            disabled={
                              removingMemberId === m.id ||
                              m.role === "owner" ||
                              manageableOrg.members.length <= 1
                            }
                            onClick={() => void handleRemoveMember(m)}
                            size="xs"
                            title={
                              m.role === "owner"
                                ? "Transfer ownership before removing this member"
                                : "Remove member"
                            }
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">Remove member</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No members yet. Invite someone to get started.
                </div>
              )}
            </div>
          </div>

          {pendingInvites.length > 0 && (
            <div className="py-7">
              <p className="mb-4 text-base font-semibold text-foreground">
                Pending invites
              </p>
              <div className="overflow-hidden rounded-lg border border-border">
                {pendingInvites.map((inv, i) => (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-2.5",
                      i !== 0 && "border-t border-border/60",
                    )}
                    key={inv.id}
                  >
                    <div>
                      <p className="text-sm text-foreground">{inv.email}</p>
                      <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                        {inv.role}
                      </p>
                    </div>
                    <Button
                      disabled={revokingId === inv.id}
                      onClick={() => void handleRevoke(inv.id)}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {revokingId === inv.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* No team selected */
        <div className="py-7">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-5 py-10 text-center">
            <Users className="h-7 w-7 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Personal team does not support members or invites. Create or
              switch to a team to collaborate.
            </p>
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="h-3.5 w-3.5" />
              Create team
            </Button>
          </div>
        </div>
      )}
      <TeamCheckoutDialog
        allowBillingIntervalSwitch
        billingInterval="yearly"
        monthlyPerSeatPrice={monthlyTeamSeatPrice}
        onOpenChange={setCreateOpen}
        open={createOpen}
        perSeatPrice={yearlyTeamSeatPrice}
        referencePrefix="settings-team"
        source="dashboard"
        yearlyPerSeatPrice={yearlyTeamSeatPrice}
      />

      {/* ── Invite dialog ── */}
      <Dialog onOpenChange={setInviteOpen} open={inviteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-0.5">
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
                htmlFor="invite-email"
              >
                Email address
              </label>
              <input
                autoFocus
                className={cn(
                  "h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                  inviteError ? "border-destructive" : "border-border",
                )}
                id="invite-email"
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  if (inviteError) setInviteError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInvite();
                }}
                placeholder="colleague@company.com"
                type="email"
                value={inviteEmail}
              />
              {inviteError ? (
                <p className="mt-1 text-xs text-destructive">{inviteError}</p>
              ) : null}
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
                htmlFor="invite-role"
              >
                Role
              </label>
              <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
                {(["member", "admin"] as const).map((r) => (
                  <button
                    className={cn(
                      "flex-1 rounded-md py-1 text-xs transition-colors capitalize",
                      inviteRole === r
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    key={r}
                    onClick={() => setInviteRole(r)}
                    type="button"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setInviteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isInviting || !inviteEmail.trim()}
              onClick={() => void handleInvite()}
              size="sm"
              type="button"
            >
              {isInviting ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
