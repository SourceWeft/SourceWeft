"use client";

import * as React from "react";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  CreditCard,
  LayoutGrid,
  LogOut,
  PanelsTopLeft,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { authClient } from "../../../lib/auth-client";
import {
  AccountPanel,
  BillingPanel,
  TeamPanel,
  TrustRulesPanel,
  UsagePanel,
  WorkspaceMembersPanel,
  type SettingsCenterTab,
} from "./dashboard-settings-center-modal";
import { useDashboardMobileNav } from "./dashboard-mobile-nav-state";
import {
  getVisibleTeamOrganizations,
  useDashboardTeamSelector,
} from "./dashboard-team-selector-shared";
import { RawImage } from "../../_components/raw-image";

type MobileMePanel = Exclude<SettingsCenterTab, "local">;

const panelItems: Array<{
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  key: MobileMePanel;
  label: string;
}> = [
  {
    key: "account",
    label: "Profile",
    description: "Account, avatar, theme, and preferences",
    icon: User,
  },
  {
    key: "team",
    label: "Team",
    description: "Team switcher, members, and invitations",
    icon: Users,
  },
  {
    key: "workspace",
    label: "Workspace",
    description: "Who can see and work in this workspace",
    icon: PanelsTopLeft,
  },
  {
    key: "usage",
    label: "Usage",
    description: "Plan usage and recent activity",
    icon: LayoutGrid,
  },
  {
    key: "billing",
    label: "Billing",
    description: "Subscription, plan, and billing portal",
    icon: CreditCard,
  },
  {
    key: "approvals",
    label: "Approvals",
    description: "Actions you chose to always allow",
    icon: ShieldCheck,
  },
];

const panelTitleByKey: Record<MobileMePanel, string> = {
  account: "Profile",
  team: "Team",
  workspace: "Workspace",
  usage: "Usage",
  billing: "Billing",
  approvals: "Approvals",
};

function getInitials(name?: string, email?: string) {
  const value = name || email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function DashboardMobileMe() {
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | {
        user?: { email?: string; image?: string | null; name?: string };
      }
    | null
    | undefined;
  const { activeOrg, orgList } = useDashboardTeamSelector();
  const { openObservability } = useDashboardMobileNav();
  const [activePanel, setActivePanel] = React.useState<MobileMePanel | null>(
    null,
  );
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const [scope, setScope] = React.useState<"personal" | "team">(
    orgList.length > 0 ? "team" : "personal",
  );

  const userName = sessionState?.user?.name;
  const userEmail = sessionState?.user?.email;
  const userImage = sessionState?.user?.image;
  const initials = getInitials(userName, userEmail);
  const visibleTeams = getVisibleTeamOrganizations(orgList);
  const hasTeam = visibleTeams.length > 0;
  const teamName = activeOrg?.name || visibleTeams[0]?.name;

  React.useEffect(() => {
    if (!hasTeam) {
      setScope("personal");
    }
  }, [hasTeam]);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:hidden">
      <header className="shrink-0 border-b border-border px-4 py-3">
        {activePanel ? (
          <div className="flex items-center gap-2">
            <Button
              className="h-8 w-8 shrink-0"
              onClick={() => setActivePanel(null)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back</span>
            </Button>
            <div className="min-w-0 text-base font-semibold text-foreground">
              {panelTitleByKey[activePanel]}
            </div>
          </div>
        ) : (
          <div className="flex h-8 items-center">
            <h1 className="text-base font-semibold text-foreground">Me</h1>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">
        {!activePanel ? (
          <div className="space-y-2">
            <div className="mb-4 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                {userImage ? (
                  <RawImage
                    alt={userName || "User avatar"}
                    className="h-16 w-16 shrink-0 rounded-2xl object-cover"
                    src={userImage}
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-muted text-lg font-semibold text-foreground">
                    {initials || "SW"}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-foreground">
                    {userName || "SourceWeft User"}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {userEmail || "Signed in"}
                  </div>
                  {teamName ? (
                    <div className="mt-2 inline-flex max-w-full rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <span className="truncate">{teamName}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {panelItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent"
                  key={item.key}
                  onClick={() => setActivePanel(item.key)}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.label}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
            <button
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent"
              onClick={openObservability}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Activity className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    Observe
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    LLM traces, metrics, and timeline
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            <button
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-3 text-left text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                  <LogOut className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {isSigningOut ? "Signing out..." : "Sign out"}
                  </span>
                  <span className="block truncate text-xs text-destructive/70">
                    End this session
                  </span>
                </span>
              </span>
            </button>
          </div>
        ) : null}

        {activePanel ? (
          <div className="min-w-0 rounded-xl border border-border bg-card p-4">
            {activePanel === "account" ? (
              <AccountPanel
                initials={initials}
                userEmail={userEmail}
                userImage={userImage}
                userName={userName}
              />
            ) : null}
            {activePanel === "team" ? (
              <TeamPanel
                hasTeam={hasTeam}
                onScopeChange={setScope}
                scope={scope}
                teamName={teamName}
              />
            ) : null}
            {activePanel === "workspace" ? <WorkspaceMembersPanel /> : null}
            {activePanel === "usage" ? <UsagePanel /> : null}
            {activePanel === "billing" ? <BillingPanel /> : null}
            {activePanel === "approvals" ? <TrustRulesPanel /> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
