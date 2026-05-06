"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  LayoutGrid,
  MailPlus,
  Plus,
  Receipt,
  User,
  Users,
  X,
} from "lucide-react";
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
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
import { billingClient } from "../../../lib/sdk";
import { useTheme } from "next-themes";
import {
  getVisibleTeamOrganizations,
  isAutoPersonalOrganization,
} from "./dashboard-team-selector-shared";

export type SettingsCenterTab = "account" | "team" | "usage" | "billing";
type BillingScope = "personal" | "team";
type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;
type BillingUsage = Awaited<ReturnType<typeof billingClient.getUsage>>;
type BillingLedger = Awaited<ReturnType<typeof billingClient.getLedger>>;
type BillingLedgerEntry = BillingLedger["items"][number];
type BillingOrg = { id: string; name: string; slug?: string };
type UsageActivityFilter = "all" | BillingLedgerEntry["unitType"];
type UsageActivityRow = {
  key: string;
  detail: string;
  date: string;
  change: string;
  unitType: UsageActivityFilter | "seat";
};

const USAGE_ACTIVITY_PAGE_SIZE = 20;
const USAGE_ACTIVITY_FETCH_LIMIT = 200;
const usageActivityFilters = [
  { label: "All", value: "all" },
  { label: "Pages", value: "page" },
  { label: "Credits", value: "credit" },
] as const satisfies Array<{
  label: string;
  value: UsageActivityFilter;
}>;

const menuItems: Array<{
  key: SettingsCenterTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: "account", label: "Profile", icon: User },
  { key: "team", label: "Team", icon: Users },
  { key: "usage", label: "Usage", icon: LayoutGrid },
  { key: "billing", label: "Billing", icon: Receipt },
];

// ── Shared primitives ─────────────────────────────────────────────────────────

function OrgSwitcher({ className }: { className?: string }) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [open, setOpen] = React.useState(false);
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{ id: string; name: string; slug: string }>,
  );
  const isPersonalActive =
    !activeOrgRecord || isAutoPersonalOrganization(activeOrgRecord);

  async function handleSwitch(orgId: string | null) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      setOpen(false);
    } catch {
      toast.error("Failed to switch workspace.");
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50",
            className,
          )}
          type="button"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-foreground">
            {isPersonalActive
              ? "P"
              : (activeOrgRecord?.name.slice(0, 2).toUpperCase() ?? "P")}
          </div>
          <span className="truncate text-sm text-foreground">
            {isPersonalActive ? "Personal workspace" : activeOrgRecord?.name}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
            isPersonalActive && "bg-accent/60",
          )}
          onClick={() => void handleSwitch(null)}
          type="button"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
            P
          </div>
          <span className="flex-1 truncate">Personal workspace</span>
          {isPersonalActive && (
            <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
          )}
        </button>
        {orgList.length > 0 && (
          <>
            <div className="my-1 border-t border-border/60" />
            {orgList.map((org) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  activeOrgRecord?.id === org.id && "bg-accent/60",
                )}
                key={org.id}
                onClick={() => void handleSwitch(org.id)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  {org.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{org.name}</span>
                {activeOrgRecord?.id === org.id && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                )}
              </button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function resolveBillingTeamId(input: {
  activeOrg?: BillingOrg | null;
  orgs?: BillingOrg[] | null;
}) {
  if (input.activeOrg?.id) {
    return input.activeOrg.id;
  }

  const personalOrg = input.orgs?.find(isAutoPersonalOrganization);
  return personalOrg?.id ?? null;
}

function isPersonalBillingOrg(org?: BillingOrg | null) {
  return !org || Boolean(isAutoPersonalOrganization(org));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPlanName(planFamily: string, personal: boolean) {
  const labelByPlan: Record<string, string> = {
    individual_free: "Free",
    individual_pro: "Pro",
    team_standard: "Team",
    team_premium: "Team Premium",
    enterprise_usage: "Enterprise",
  };

  return labelByPlan[planFamily] ?? (personal ? "Personal" : "Team");
}

function formatFeatureName(feature: string) {
  const label = feature
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return label || "Usage";
}

function formatUsageDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
  }).format(new Date(value));
}

function formatLedgerChange(entry: BillingLedgerEntry) {
  const prefix = entry.delta > 0 ? "+" : "";
  return `${prefix}${formatNumber(entry.delta)}`;
}

function formatLedgerUnit(unitType: BillingLedgerEntry["unitType"]) {
  return unitType === "page" ? "pages" : "credits";
}

function formatLedgerActivityChange(entry: BillingLedgerEntry) {
  return `${formatLedgerChange(entry)} ${formatLedgerUnit(
    entry.unitType,
  )} · ${formatNumber(Math.max(entry.balanceAfter, 0))} left`;
}

function formatLedgerDetail(entry: BillingLedgerEntry) {
  const feature = formatFeatureName(entry.feature);

  if (entry.eventType === "consume") {
    if (entry.unitType === "page" && entry.feature === "ingestion") {
      return "Pages indexed";
    }

    if (entry.unitType === "credit") {
      return `${feature} credits used`;
    }

    return `${feature} pages used`;
  }

  if (entry.eventType === "grant") {
    if (entry.feature === "cycle_grant") {
      return entry.unitType === "page"
        ? "Monthly pages granted"
        : "Monthly credits granted";
    }

    if (entry.feature === "seat_quota_grant") {
      return entry.unitType === "page"
        ? "Seat pages granted"
        : "Seat credits granted";
    }

    if (entry.feature === "plan_upgrade_grant") {
      return entry.unitType === "page"
        ? "Plan pages granted"
        : "Plan credits granted";
    }

    if (entry.unitType === "page" && entry.feature === "shadow_auto_grant") {
      return "Add-on pages granted";
    }

    return `${feature} granted`;
  }

  if (entry.eventType === "expire") {
    return entry.unitType === "page"
      ? "Monthly pages expired"
      : "Unused credits expired";
  }

  if (entry.eventType === "adjust") {
    if (entry.feature === "seat_quota_change") {
      return "Seat page quota adjusted";
    }

    return `${feature} adjusted`;
  }

  if (entry.eventType === "refund") {
    return `${feature} refunded`;
  }

  if (entry.eventType === "reserve") {
    return `${feature} reserved`;
  }

  if (entry.eventType === "release") {
    return `${feature} released`;
  }

  return feature;
}

function isLedgerEntryInCycle(entry: BillingLedgerEntry, summary: BillingSummary) {
  const createdAtMs = Date.parse(entry.createdAt);
  return (
    createdAtMs >= Date.parse(summary.cycleStartAt) &&
    createdAtMs < Date.parse(summary.cycleEndAt)
  );
}

function buildUsageMetrics(input: {
  summary: BillingSummary;
  personal: boolean;
  usageEventCount: number;
}) {
  const seatsMetric = input.personal
    ? {
        label: "Usage events",
        value: formatNumber(input.usageEventCount),
      }
    : {
        label: "Seats used / left",
        value: `${formatNumber(input.summary.seats.used)} / ${formatNumber(
          input.summary.seats.remaining,
        )}`,
      };

  return [
    {
      label: "Credits used",
      value: formatNumber(input.summary.credits.consumedThisCycle),
    },
    {
      label: "Pages used / left",
      value: `${formatNumber(
        input.summary.pages.consumedThisCycle,
      )} / ${formatNumber(input.summary.pages.available)}`,
    },
    seatsMetric,
  ];
}

// ── Account / Profile panel ───────────────────────────────────────────────────

function AccountPanel({
  userName,
  userEmail,
  userImage,
  initials,
}: {
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  initials: string;
}) {
  const [displayName, setDisplayName] = React.useState(userName ?? "");
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(
    userImage ?? null,
  );
  const [avatarDirty, setAvatarDirty] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    setDisplayName(userName ?? "");
  }, [userName]);
  React.useEffect(() => {
    setAvatarPreview(userImage ?? null);
    setAvatarDirty(false);
  }, [userImage]);

  const trimmed = displayName.trim();
  const isDirty = trimmed !== (userName ?? "") || avatarDirty;

  async function handleSave() {
    if (!trimmed) {
      setNameError("Name is required.");
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const result = await authClient.updateUser({
        name: trimmed,
        image: avatarPreview ?? undefined,
      });
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            "Unable to save.",
        );
      }
      setAvatarDirty(false);
      toast.success("Profile saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarPreview(
        typeof reader.result === "string" ? reader.result : null,
      );
      setAvatarDirty(true);
    };
    reader.readAsDataURL(file);
  }

  async function handleDeleteAccount() {
    setIsDeleting(true);
    try {
      const result = await authClient.deleteUser();
      if ((result as { error?: { message?: string } } | null)?.error) {
        throw new Error(
          (result as { error?: { message?: string } }).error?.message ??
            "Unable to delete account.",
        );
      }
      toast.success("Account deletion started");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Unable to delete account.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Profile ── */}
      <div className="pb-7 pt-1">
        <p className="mb-5 text-base font-semibold text-foreground">Profile</p>
        <div className="flex gap-5">
          {/* Avatar */}
          <div className="shrink-0">
            <input
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarFile}
              ref={fileInputRef}
              type="file"
            />
            <button
              className="group relative h-14 w-14 overflow-hidden rounded-full border border-border bg-muted text-sm font-semibold text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title="Change avatar"
              type="button"
            >
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="Avatar"
                  className="h-full w-full object-cover"
                  src={avatarPreview}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center">
                  {initials}
                </span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                Change
              </span>
            </button>
          </div>

          {/* Name field */}
          <div className="flex-1">
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="display-name"
            >
              Display name
            </label>
            <input
              className={cn(
                "h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                nameError ? "border-destructive" : "border-border",
              )}
              id="display-name"
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="Your display name"
              type="text"
              value={displayName}
            />
            {nameError ? (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            ) : null}
            {isDirty && (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  disabled={isSaving}
                  onClick={() => void handleSave()}
                  size="sm"
                  type="button"
                >
                  {isSaving ? "Saving…" : "Save changes"}
                </Button>
                <Button
                  disabled={isSaving}
                  onClick={() => {
                    setDisplayName(userName ?? "");
                    setAvatarPreview(userImage ?? null);
                    setAvatarDirty(false);
                    setNameError(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Appearance ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">
          Appearance
        </p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">Theme</p>
            <p className="text-xs text-muted-foreground">
              Choose how SourceWeft looks to you.
            </p>
          </div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["light", "system", "dark"] as const).map((t) => (
              <button
                className={cn(
                  "rounded-md px-3 py-1 text-xs transition-colors",
                  (theme ?? "system") === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={t}
                onClick={() => setTheme(t)}
                type="button"
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Language ── */}
      <div className="py-7">
        <p className="mb-4 text-base font-semibold text-foreground">Language</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">Interface language</p>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground opacity-60"
              disabled
              type="button"
            >
              English
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">Response language</p>
              <p className="text-xs text-muted-foreground">Not available yet</p>
            </div>
            <button
              className="inline-flex h-8 min-w-[130px] cursor-not-allowed items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground opacity-40"
              disabled
              type="button"
            >
              Coming soon
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Account ── */}
      <div className="pt-7">
        <p className="mb-4 text-base font-semibold text-foreground">Account</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-foreground">{userEmail}</p>
              <p className="text-xs text-muted-foreground">Signed-in account</p>
            </div>
            <Button
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-destructive">
                Delete account
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permanently removes your account and all data. Cannot be undone.
              </p>
            </div>
            <Button
              className="shrink-0"
              disabled={isDeleting}
              onClick={() => void handleDeleteAccount()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Team panel ────────────────────────────────────────────────────────────────

function TeamPanel({
  onScopeChange,
}: {
  hasTeam: boolean;
  scope: BillingScope;
  onScopeChange: (scope: BillingScope) => void;
  teamName?: string;
}) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [newTeamName, setNewTeamName] = React.useState("");
  const [isCreating, setIsCreating] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"admin" | "member">(
    "member",
  );
  const [isInviting, setIsInviting] = React.useState(false);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  async function handleSwitch(orgId: string | null) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      setSwitcherOpen(false);
      onScopeChange(orgId ? "team" : "personal");
    } catch {
      toast.error("Failed to switch workspace.");
    }
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      await authClient.organization.create({ name, slug });
      setCreateOpen(false);
      setNewTeamName("");
      toast.success("Team created.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create team.",
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteError(null);
    setIsInviting(true);
    try {
      const result = (await authClient.organization.inviteMember({
        email,
        role: inviteRole,
        organizationId: activeOrgFull!.id,
      })) as { error?: { message?: string } } | null;
      if (result?.error)
        throw new Error(result.error.message ?? "Failed to send invite.");
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
      await authClient.organization.cancelInvitation({ invitationId });
      toast.success("Invitation revoked.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{ id: string; name: string; slug: string }>,
  );
  const activeOrgFull = activeOrg as
    | {
        id: string;
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

  const pendingInvites =
    activeOrgFull?.invitations?.filter((inv) => inv.status === "pending") ?? [];

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Workspace ── */}
      <div className="pb-7 pt-1">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-base font-semibold text-foreground">Workspace</p>
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
                  {activeOrgFull
                    ? activeOrgFull.name.slice(0, 2).toUpperCase()
                    : "P"}
                </div>
                <span className="truncate text-sm text-foreground">
                  {activeOrgFull ? activeOrgFull.name : "Personal workspace"}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[260px] p-1.5">
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                !activeOrgFull && "bg-accent/60",
              )}
              onClick={() => void handleSwitch(null)}
              type="button"
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                P
              </div>
              <span className="flex-1 truncate">Personal workspace</span>
              {!activeOrgFull && (
                <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
              )}
            </button>
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
                    onClick={() => void handleSwitch(org.id)}
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
      {activeOrgFull ? (
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
              {activeOrgFull.members?.length ? (
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
                    {activeOrgFull.members.map((m) => (
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
                          <Button size="xs" type="button" variant="ghost">
                            ···
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
              Switch to a team workspace to manage members and invites.
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

      {/* ── Create team dialog ── */}
      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create team</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 px-0.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="new-team-name"
            >
              Team name
            </label>
            <input
              autoFocus
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
              id="new-team-name"
              onChange={(e) => setNewTeamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
              placeholder="e.g. Acme Inc."
              type="text"
              value={newTeamName}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isCreating || !newTeamName.trim()}
              onClick={() => void handleCreate()}
              size="sm"
              type="button"
            >
              {isCreating ? "Creating…" : "Create team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

// ── Usage panel ───────────────────────────────────────────────────────────────

function UsagePanel() {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;
  const orgList = (orgs ?? []) as BillingOrg[];
  const resolvingPersonalTeamId = !activeOrgRecord && orgs === undefined;
  const teamId = resolveBillingTeamId({
    activeOrg: activeOrgRecord,
    orgs: orgList,
  });
  const isPersonal = isPersonalBillingOrg(activeOrgRecord);
  const [summary, setSummary] = React.useState<BillingSummary | null>(null);
  const [usage, setUsage] = React.useState<BillingUsage | null>(null);
  const [ledger, setLedger] = React.useState<BillingLedgerEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activityFilter, setActivityFilter] =
    React.useState<UsageActivityFilter>("all");
  const [activityVisibleCount, setActivityVisibleCount] = React.useState(
    USAGE_ACTIVITY_PAGE_SIZE,
  );

  React.useEffect(() => {
    let cancelled = false;

    async function loadUsage() {
      if (!teamId) {
        setSummary(null);
        setUsage(null);
        setLedger([]);
        setLoading(resolvingPersonalTeamId);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const [nextSummary, nextUsage, nextLedger] = await Promise.all([
          billingClient.getSummary(teamId),
          billingClient.getUsage(teamId),
          billingClient.getLedger(teamId, { limit: USAGE_ACTIVITY_FETCH_LIMIT }),
        ]);

        if (cancelled) {
          return;
        }

        setSummary(nextSummary);
        setUsage(nextUsage);
        setLedger(nextLedger.items);
      } catch (err) {
        if (cancelled) {
          return;
        }

        setSummary(null);
        setUsage(null);
        setLedger([]);
        setError(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadUsage();

    return () => {
      cancelled = true;
    };
  }, [resolvingPersonalTeamId, teamId]);

  React.useEffect(() => {
    setActivityVisibleCount(USAGE_ACTIVITY_PAGE_SIZE);
  }, [teamId]);

  const creditsUsed = summary?.credits.consumedThisCycle ?? 0;
  const creditsLimit = summary?.credits.monthlyGrant ?? 0;
  const creditsPercent =
    creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : 0;
  const pagesUsed = summary?.pages.consumedThisCycle ?? 0;
  const pagesMonthlyGrant = summary?.pages.monthlyGrant ?? 0;
  const pagesPercent =
    pagesMonthlyGrant > 0
      ? Math.min(100, (pagesUsed / pagesMonthlyGrant) * 100)
      : 0;
  const cycleLedgerEntries = summary
    ? ledger.filter((entry) => isLedgerEntryInCycle(entry, summary))
    : ledger;
  const usageEventCount = cycleLedgerEntries.filter(
    (entry) => entry.eventType === "consume",
  ).length;
  const seatActivityRow: UsageActivityRow | null =
    summary && !isPersonal && activityFilter === "all"
      ? {
          detail: "Seats occupied",
          date: formatUsageDate(new Date().toISOString()),
          change: `${formatNumber(summary.seats.used)} used / ${formatNumber(
            summary.seats.remaining,
          )} left`,
          key: "seats-current",
          unitType: "seat",
        }
      : null;
  const ledgerActivityLimit =
    activityVisibleCount - (seatActivityRow ? 1 : 0);
  const filteredLedgerEntries =
    activityFilter === "all"
      ? cycleLedgerEntries
      : cycleLedgerEntries.filter((entry) => entry.unitType === activityFilter);
  const ledgerActivityRows = filteredLedgerEntries
    .slice(0, ledgerActivityLimit)
    .map<UsageActivityRow>((entry) => ({
      detail: formatLedgerDetail(entry),
      date: formatUsageDate(entry.createdAt),
      change: formatLedgerActivityChange(entry),
      key: entry.id,
      unitType: entry.unitType,
    }));
  const activityRows = seatActivityRow
    ? [seatActivityRow, ...ledgerActivityRows]
    : ledgerActivityRows;
  const totalActivityRowCount =
    filteredLedgerEntries.length + (seatActivityRow ? 1 : 0);
  const hasMoreActivityRows = activityRows.length < totalActivityRowCount;
  const data = {
    plan: summary
      ? formatPlanName(summary.planFamily, isPersonal)
      : isPersonal
        ? "Personal"
        : "Team",
    creditsLabel: summary
      ? `${formatNumber(creditsUsed)} / ${formatNumber(creditsLimit)} credits`
      : loading
        ? "Loading credits..."
        : "-- / -- credits",
    creditsPercent,
    pagesLabel: summary
      ? `${formatNumber(pagesUsed)} used · ${formatNumber(
          summary.pages.available,
        )} left`
      : loading
        ? "Loading pages..."
        : "-- used · -- left",
    pagesPercent,
    pagesWallet: summary
      ? `Monthly ${formatNumber(
          summary.pages.monthlyBalance,
        )} · Add-on ${formatNumber(summary.pages.addOnBalance)}`
      : loading
        ? "Monthly ... · Add-on ..."
        : "Monthly -- · Add-on --",
    metrics:
      summary
        ? buildUsageMetrics({
            personal: isPersonal,
            summary,
            usageEventCount: usage?.totals.events ?? usageEventCount,
          })
        : [
            { label: "Credits used", value: loading ? "..." : "--" },
            { label: "Pages used / left", value: loading ? "..." : "--" },
            {
              label: isPersonal ? "Usage events" : "Seats used / left",
              value: loading ? "..." : "--",
            },
          ],
  };
  const emptyActivityLabel = loading
    ? "Loading activity..."
    : teamId
      ? activityFilter === "all"
        ? "No usage activity yet"
        : `No ${formatLedgerUnit(activityFilter)} activity yet`
      : "Usage account unavailable";

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 pb-7 pt-1">
        <p className="text-base font-semibold text-foreground">Usage</p>
        <OrgSwitcher />
      </div>

      {/* ── Plan + credits ── */}
      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {data.plan} plan
            </p>
            <Button size="sm" type="button" variant="outline">
              Manage plan
            </Button>
          </div>
          <div className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Credits</span>
              <span className="font-medium text-foreground">
                {data.creditsLabel}
              </span>
            </div>
            <Progress className="h-1.5 bg-muted" value={data.creditsPercent} />
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">Pages</span>
              <span className="text-right font-medium text-foreground">
                {data.pagesLabel}
              </span>
            </div>
            <Progress className="h-1.5 bg-muted" value={data.pagesPercent} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {data.pagesWallet}
            </p>
          </div>
          <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
            {data.metrics.map((m) => (
              <div className="px-4 py-3" key={m.label}>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {m.label}
                </p>
                <p className="mt-0.5 text-base font-semibold text-foreground">
                  {m.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Activity ── */}
      <div className="pt-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-base font-semibold text-foreground">Activity</p>
          <div
            aria-label="Filter usage activity"
            className="flex rounded-lg border border-border bg-muted/40 p-0.5"
            role="group"
          >
            {usageActivityFilters.map((filter) => (
              <button
                aria-pressed={activityFilter === filter.value}
                className={cn(
                  "min-w-14 rounded-md px-2.5 py-1 text-xs transition-colors",
                  activityFilter === filter.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={filter.value}
                onClick={() => {
                  setActivityFilter(filter.value);
                  setActivityVisibleCount(USAGE_ACTIVITY_PAGE_SIZE);
                }}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Detail
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Date
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {activityRows.length > 0 ? (
                activityRows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-2.5 text-foreground">
                      {row.detail}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.date}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-foreground">
                      {row.change}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-2.5 text-foreground">
                    {emptyActivityLabel}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">--</td>
                  <td className="px-4 py-2.5 text-right font-medium text-foreground">
                    --
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {hasMoreActivityRows && (
          <div className="px-4 py-2">
            <Button
              className="h-auto w-full justify-center px-0 py-1 text-[11px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() =>
                setActivityVisibleCount((count) =>
                  Math.min(
                    count + USAGE_ACTIVITY_PAGE_SIZE,
                    totalActivityRowCount,
                  ),
                )
              }
              size="xs"
              type="button"
              variant="ghost"
            >
              Load more
            </Button>
          </div>
        )}
        {error && (
          <p className="mt-3 text-xs text-muted-foreground">{error}</p>
        )}
      </div>
    </div>
  );
}

// ── Billing panel ─────────────────────────────────────────────────────────────

function BillingPanel() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const isTeam = !!activeOrg;

  const data = isTeam
    ? {
        title: "Team",
        status: "Trialing · Trial ends May 12, 2026",
        nextPayment: "$80.00",
        usage: "11,600 / 80,000 credits",
        paymentMethod: "Mastercard ···· 2244",
        invoices: [
          { period: "Apr 2026", amount: "$80.00", status: "Due" },
          { period: "Mar 2026", amount: "$80.00", status: "Paid" },
        ],
      }
    : {
        title: "Pro",
        status: "Active · Renews May 7, 2026",
        nextPayment: "$20.00",
        usage: "2,400 / 20,000 credits",
        paymentMethod: "Visa ···· 4242",
        invoices: [
          { period: "Apr 2026", amount: "$20.00", status: "Paid" },
          { period: "Mar 2026", amount: "$20.00", status: "Paid" },
        ],
      };

  return (
    <div className="w-full max-w-2xl divide-y divide-border/60">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 pb-7 pt-1">
        <p className="text-base font-semibold text-foreground">Billing</p>
        <OrgSwitcher />
      </div>

      {/* ── Plan ── */}
      <div className="py-7">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {data.title} plan
              </p>
              <p className="text-xs text-muted-foreground">{data.status}</p>
            </div>
            <Button size="sm" type="button" variant="outline">
              Manage
            </Button>
          </div>
          <div className="grid grid-cols-3 divide-x divide-border">
            {[
              { label: "Next payment", value: data.nextPayment },
              { label: "Usage", value: data.usage },
              { label: "Payment method", value: data.paymentMethod },
            ].map((item) => (
              <div className="px-4 py-3" key={item.label}>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {item.label}
                </p>
                <p className="mt-0.5 text-sm font-medium text-foreground">
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Invoices ── */}
      <div className="pt-7">
        <p className="mb-4 text-base font-semibold text-foreground">Invoices</p>
        <div className="overflow-hidden rounded-lg border border-border">
          {data.invoices.map((inv, i) => (
            <div
              className={cn(
                "flex items-center justify-between gap-3 px-4 py-3",
                i !== 0 && "border-t border-border/60",
              )}
              key={`${inv.period}-${inv.amount}`}
            >
              <div>
                <p className="text-sm text-foreground">{inv.period}</p>
                <p className="text-xs text-muted-foreground">
                  {inv.amount} · {inv.status}
                </p>
              </div>
              <Button size="sm" type="button" variant="outline">
                Download
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

export function DashboardSettingsCenterModal({
  open,
  onOpenChange,
  userName,
  userEmail,
  userImage,
  initials,
  teamName,
  initialTab,
  hasTeam = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  initials: string;
  teamName?: string;
  initialTab: SettingsCenterTab;
  hasTeam?: boolean;
}) {
  const [activeTab, setActiveTab] =
    React.useState<SettingsCenterTab>(initialTab);
  const [scope, setScope] = React.useState<BillingScope>(
    hasTeam ? "team" : "personal",
  );
  const wasOpenRef = React.useRef(open);

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab(initialTab);
    }
    wasOpenRef.current = open;
  }, [open, initialTab]);

  React.useEffect(() => {
    if (!hasTeam) setScope("personal");
  }, [hasTeam]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(780px,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border/80 bg-background p-0 shadow-2xl sm:w-[min(900px,calc(100vw-2rem))] sm:max-w-[min(900px,calc(100vw-2rem))]"
        constrainWidth={false}
        showCloseButton={false}
      >
        <div className="grid h-full grid-cols-1 sm:grid-cols-[180px_minmax(0,1fr)]">
          {/* ── Sidebar ── */}
          <aside className="flex min-h-0 flex-col border-b border-border/70 bg-muted/30 sm:border-b-0 sm:border-r">
            {/* User identity */}
            <div className="border-b border-border/70 px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {userName ?? "SourceWeft User"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {userEmail}
                  </p>
                </div>
              </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 overflow-y-auto px-2.5 py-2.5">
              <div className="space-y-0.5">
                {menuItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.key;
                  return (
                    <button
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                      )}
                      key={item.key}
                      onClick={() => setActiveTab(item.key)}
                      type="button"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </nav>
          </aside>

          {/* ── Content ── */}
          <div className="relative min-h-0 overflow-hidden">
            {/* Close button */}
            <button
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Scrollable area */}
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 pb-10 pt-6 pr-12">
              {activeTab === "account" && (
                <AccountPanel
                  initials={initials}
                  userEmail={userEmail}
                  userImage={userImage}
                  userName={userName}
                />
              )}
              {activeTab === "team" && (
                <TeamPanel
                  hasTeam={hasTeam}
                  onScopeChange={setScope}
                  scope={scope}
                  teamName={teamName}
                />
              )}
              {activeTab === "usage" && <UsagePanel />}
              {activeTab === "billing" && <BillingPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
