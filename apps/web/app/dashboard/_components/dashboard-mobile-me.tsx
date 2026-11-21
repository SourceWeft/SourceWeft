"use client";
import { disconnectLocalHostSession } from "../../../lib/local-host-session";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useBillingAvailable } from "../../../lib/billing-edition/capabilities";
import { usePurchasesAllowed } from "../../../lib/native-host";
import { isSettingsTabAvailable } from "../../../lib/billing-edition/visibility";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  ChevronRight,
  CreditCard,
  Info,
  LayoutGrid,
  PanelLeftOpen,
  PanelsTopLeft,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
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
import {
  getMobileMeInitials,
  MobileMeAvatar,
  useMobileMeUser,
} from "./dashboard-mobile-me-entry";
import { useDashboardMobileNav } from "./dashboard-mobile-nav-state";
import {
  getVisibleTeamOrganizations,
  useDashboardTeamSelector,
} from "./dashboard-team-selector-shared";
import { useWorkspaceLayout } from "./dashboard-workspace-layout";

type MobileMePanel = Exclude<SettingsCenterTab, "local">;
type IconComponent = React.ComponentType<{ className?: string }>;

// Grouped like the iOS Settings app: one rounded card per group, a tinted
// icon per row.
const panelGroups: Array<
  Array<{ icon: IconComponent; key: MobileMePanel; tint: string }>
> = [
  [
    { key: "team", icon: Users, tint: "bg-sky-500" },
    { key: "workspace", icon: PanelsTopLeft, tint: "bg-indigo-500" },
  ],
  [
    { key: "usage", icon: LayoutGrid, tint: "bg-emerald-500" },
    { key: "billing", icon: CreditCard, tint: "bg-amber-500" },
  ],
  [{ key: "approvals", icon: ShieldCheck, tint: "bg-teal-500" }],
];

function MeGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card [&>*+*]:border-t [&>*+*]:border-border/60">
      {children}
    </div>
  );
}

function MeRowContent({
  icon: Icon,
  label,
  tint,
}: {
  icon: IconComponent;
  label: string;
  tint: string;
}) {
  return (
    <>
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg text-white",
          tint,
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">
        {label}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
    </>
  );
}

const rowClass =
  "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-accent hover:bg-accent/60";

export function DashboardMobileMe() {
  const t = useTranslations("dashboardNav");
  const billingAvailable = useBillingAvailable();
  const purchasesAllowed = usePurchasesAllowed();
  const user = useMobileMeUser();
  const { activeOrg, orgList } = useDashboardTeamSelector();
  const { openMain, openObservability } = useDashboardMobileNav();
  const { conversationsOpen, toggleConversations } = useWorkspaceLayout();
  const [activePanel, setActivePanel] = React.useState<MobileMePanel | null>(
    null,
  );
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const [scope, setScope] = React.useState<"personal" | "team">(
    orgList.length > 0 ? "team" : "personal",
  );

  const userName = user?.name;
  const userEmail = user?.email;
  const userImage = user?.image;
  const initials = getMobileMeInitials(userName, userEmail);
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

  const available = (key: MobileMePanel) =>
    isSettingsTabAvailable(key, billingAvailable, purchasesAllowed);
  const drawerLabel = conversationsOpen
    ? t("sidebar.hideSidebar")
    : t("sidebar.showSidebar");

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {activePanel ? (
          <Button
            className="size-8 shrink-0"
            onClick={() => setActivePanel(null)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            <span className="sr-only">{t("common.back")}</span>
          </Button>
        ) : (
          <Button
            aria-expanded={conversationsOpen}
            aria-label={drawerLabel}
            className="size-8 shrink-0"
            data-conversations-toggle
            onClick={toggleConversations}
            size="icon"
            title={drawerLabel}
            type="button"
            variant="ghost"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        )}
        <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {activePanel
            ? t(`mobileMe.panels.${activePanel}.label`)
            : t("nav.me")}
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-5">
        {!activePanel ? (
          <div className="space-y-6">
            <MeGroup>
              <button
                className={cn(rowClass, "gap-4 py-4")}
                onClick={() => setActivePanel("account")}
                type="button"
              >
                <MobileMeAvatar className="size-14 text-lg" user={user} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-semibold text-foreground">
                    {userName || t("account.sourceweftUser")}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    {userEmail || t("account.signedIn")}
                  </span>
                  {teamName ? (
                    <span className="mt-1.5 inline-flex max-w-full rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      <span className="truncate">{teamName}</span>
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
              </button>
            </MeGroup>

            {panelGroups.map((group, index) => {
              const items = group.filter((item) => available(item.key));
              if (items.length === 0) return null;
              return (
                <MeGroup key={index}>
                  {items.map((item) => (
                    <button
                      className={rowClass}
                      key={item.key}
                      onClick={() => setActivePanel(item.key)}
                      type="button"
                    >
                      <MeRowContent
                        icon={item.icon}
                        label={t(`mobileMe.panels.${item.key}.label`)}
                        tint={item.tint}
                      />
                    </button>
                  ))}
                </MeGroup>
              );
            })}

            <MeGroup>
              <Link
                className={rowClass}
                href="/dashboard/scheduled"
                onClick={openMain}
              >
                <MeRowContent
                  icon={CalendarClock}
                  label={t("nav.scheduled")}
                  tint="bg-orange-500"
                />
              </Link>
              <button
                className={rowClass}
                onClick={openObservability}
                type="button"
              >
                <MeRowContent
                  icon={Activity}
                  label={t("common.observe")}
                  tint="bg-rose-500"
                />
              </button>
              {available("about") ? (
                <button
                  className={rowClass}
                  onClick={() => setActivePanel("about")}
                  type="button"
                >
                  <MeRowContent
                    icon={Info}
                    label={t("mobileMe.panels.about.label")}
                    tint="bg-zinc-500"
                  />
                </button>
              ) : null}
            </MeGroup>

            <MeGroup>
              <button
                className={cn(
                  rowClass,
                  "justify-center text-[15px] font-medium text-destructive disabled:opacity-60",
                )}
                disabled={isSigningOut}
                onClick={() => void handleSignOut()}
                type="button"
              >
                {isSigningOut
                  ? t("mobileMe.signingOut")
                  : t("mobileMe.signOut")}
              </button>
            </MeGroup>
          </div>
        ) : (
          <div className="min-w-0 rounded-2xl border border-border/60 bg-card p-4">
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
        )}
      </div>
    </main>
  );
}
