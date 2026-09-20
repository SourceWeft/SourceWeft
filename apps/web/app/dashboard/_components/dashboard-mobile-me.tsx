"use client";
import { disconnectLocalHostSession } from "../../../lib/local-host-session";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useBillingAvailable } from "../../../lib/billing-edition/capabilities";
import { isSettingsTabAvailable } from "../../../lib/billing-edition/visibility";
import { useAuthenticate } from "@better-auth-ui/react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  CreditCard,
  Info,
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
  AboutPanel,
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
  icon: React.ComponentType<{ className?: string }>;
  key: MobileMePanel;
}> = [
  { key: "account", icon: User },
  { key: "team", icon: Users },
  { key: "workspace", icon: PanelsTopLeft },
  { key: "usage", icon: LayoutGrid },
  { key: "billing", icon: CreditCard },
  { key: "approvals", icon: ShieldCheck },
  { key: "about", icon: Info },
];

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
  const t = useTranslations("dashboardNav");
  const billingAvailable = useBillingAvailable();
  const authState = useAuthenticate(authClient);
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
      await disconnectLocalHostSession();
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
              <span className="sr-only">{t("common.back")}</span>
            </Button>
            <div className="min-w-0 text-base font-semibold text-foreground">
              {t(`mobileMe.panels.${activePanel}.label`)}
            </div>
          </div>
        ) : (
          <div className="flex h-8 items-center">
            <h1 className="text-base font-semibold text-foreground">
              {t("nav.me")}
            </h1>
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
                    alt={userName || t("account.userAvatarAlt")}
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
                    {userName || t("account.sourceweftUser")}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {userEmail || t("account.signedIn")}
                  </div>
                  {teamName ? (
                    <div className="mt-2 inline-flex max-w-full rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <span className="truncate">{teamName}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {panelItems
              .filter((item) =>
                isSettingsTabAvailable(item.key, billingAvailable),
              )
              .map((item) => {
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
                          {t(`mobileMe.panels.${item.key}.label`)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t(`mobileMe.panels.${item.key}.description`)}
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
                    {t("common.observe")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("mobileMe.observeDescription")}
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
                    {isSigningOut
                      ? t("mobileMe.signingOut")
                      : t("mobileMe.signOut")}
                  </span>
                  <span className="block truncate text-xs text-destructive/70">
                    {t("mobileMe.endSession")}
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
            {activePanel === "about" ? <AboutPanel /> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
