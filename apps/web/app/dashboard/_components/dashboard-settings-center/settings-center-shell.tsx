"use client";

import * as React from "react";
import {
  isSettingsTabAvailable,
  resolveSettingsTab,
} from "../../../../lib/billing-edition/visibility";
import { LayoutGrid, Receipt, ShieldCheck, User, Users, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { AccountPanel } from "./account-panel";
import { BillingPanel } from "./billing-panel";
import { TeamPanel } from "./team-panel";
import { TrustRulesPanel } from "./trust-rules-panel";
import { UsagePanel } from "./usage-panel";
import type { BillingScope, SettingsCenterTab } from "./types";

const menuItems: Array<{
  key: SettingsCenterTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: "account", label: "Profile", icon: User },
  { key: "team", label: "Team", icon: Users },
  // Workspace membership is per-workspace, not an account setting — it lives in
  // the standalone WorkspaceMembersDialog opened from the sidebar.
  { key: "usage", label: "Usage", icon: LayoutGrid },
  { key: "billing", label: "Billing", icon: Receipt },
  { key: "approvals", label: "Approvals", icon: ShieldCheck },
];

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
  const [activeTab, setActiveTab] = React.useState<SettingsCenterTab>(() =>
    resolveSettingsTab(initialTab),
  );
  const [scope, setScope] = React.useState<BillingScope>(
    hasTeam ? "team" : "personal",
  );
  const wasOpenRef = React.useRef(open);

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab(resolveSettingsTab(initialTab));
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
        <DialogTitle className="sr-only">Settings center</DialogTitle>
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
                {menuItems
                  .filter((item) => isSettingsTabAvailable(item.key))
                  .map((item) => {
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
              {activeTab === "approvals" && <TrustRulesPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
