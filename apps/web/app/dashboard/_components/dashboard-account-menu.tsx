"use client";
import { disconnectLocalHostSession } from "../../../lib/local-host-session";
import { useBillingAvailable } from "../../../lib/billing-edition/capabilities";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAuthenticate } from "@better-auth-ui/react";
import {
  CreditCard,
  ChevronsUpDown,
  Keyboard,
  LayoutGrid,
  LogOut,
  Plus,
  User,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
import type { SettingsCenterTab } from "./dashboard-settings-center-modal";
import {
  DashboardTeamDisplay,
  type DashboardTeamItem,
  useDashboardTeamSelector,
} from "./dashboard-team-selector-shared";
import { dispatchDashboardShortcutsOpen } from "./dashboard-shortcuts";
import { DashboardSettingsCenterModalSkeleton } from "./dashboard-settings-center-modal-skeleton";
import { RawImage } from "../../_components/raw-image";

const DashboardSettingsCenterModal = React.lazy(async () => {
  const settingsModal = await import("./dashboard-settings-center-modal");
  return { default: settingsModal.DashboardSettingsCenterModal };
});

function getInitials(name?: string, email?: string) {
  const value = name || email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function DashboardAccountMenu({
  settingsRequest,
  expanded = false,
}: {
  expanded?: boolean;
  settingsRequest?: { id: number; tab: SettingsCenterTab } | null;
}) {
  const t = useTranslations("dashboardNav");
  const { isMobile } = useSidebar();
  const billingAvailable = useBillingAvailable();
  const authState = useAuthenticate(authClient);
  const sessionState = authState.data as
    | {
        user?: { email?: string; image?: string | null; name?: string };
        session?: { activeOrganizationId?: string | null };
      }
    | null
    | undefined;

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [initialTab, setInitialTab] =
    React.useState<SettingsCenterTab>("account");
  const [teamSwitcherOpen, setTeamSwitcherOpen] = React.useState(false);

  const { activeOrg, currentItem, items, orgList, switchTeam, user } =
    useDashboardTeamSelector();

  const userName = sessionState?.user?.name;
  const userEmail = sessionState?.user?.email;
  const userImage = sessionState?.user?.image;
  const initials = getInitials(userName, userEmail);

  const openSettings = React.useCallback((tab: SettingsCenterTab) => {
    setInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  React.useEffect(() => {
    if (!settingsRequest) {
      return;
    }

    openSettings(settingsRequest.tab);
  }, [openSettings, settingsRequest]);

  async function handleSwitchTeam(item: DashboardTeamItem) {
    try {
      await switchTeam(item);
      setTeamSwitcherOpen(false);
    } catch {
      toast.error(t("team.switchError"));
    }
  }

  async function handleSignOut() {
    await disconnectLocalHostSession();
    await authClient.signOut();
  }

  return (
    <>
      <SidebarMenu className={expanded ? "gap-2" : "items-center gap-2"}>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={t("account.accountAndSettings")}
                className={
                  expanded
                    ? "flex h-10 w-full items-center gap-2 rounded-lg px-1 text-left text-sm hover:bg-sidebar-accent"
                    : "flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-sm font-semibold text-foreground shadow-xs"
                }
                type="button"
              >
                {userImage ? (
                  <RawImage
                    alt={userName ?? t("account.userAlt")}
                    className="h-8 w-8 rounded-lg object-cover"
                    src={userImage}
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold">
                    {initials || "SW"}
                  </span>
                )}
                {expanded && (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      {userName || userEmail || t("account.accountFallback")}
                    </span>
                    <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              side={expanded ? "top" : isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage
                      src={userImage ?? undefined}
                      alt={userName ?? t("account.userAlt")}
                    />
                    <AvatarFallback className="rounded-lg">
                      {initials || "SW"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {userName || t("account.sourceweftUser")}
                    </span>
                    <span className="truncate text-xs">
                      {userEmail || t("account.signedIn")}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuSub
                open={teamSwitcherOpen}
                onOpenChange={setTeamSwitcherOpen}
              >
                <DropdownMenuSubTrigger className="gap-2 p-2">
                  {currentItem ? (
                    <DashboardTeamDisplay
                      item={currentItem}
                      labelClassName="flex-1 text-left text-sm font-medium"
                      user={user}
                      variant="menu"
                    />
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className="w-64 rounded-lg"
                  sideOffset={4}
                >
                  {items.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onClick={() => void handleSwitchTeam(item)}
                      className="gap-2 p-2"
                    >
                      <DashboardTeamDisplay
                        item={item}
                        labelClassName="text-sm"
                        user={user}
                        variant="menu"
                      />
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setTeamSwitcherOpen(false);
                      openSettings("team");
                    }}
                    className="gap-2 p-2"
                  >
                    <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                      <Plus className="size-4" />
                    </div>
                    <div className="font-medium text-muted-foreground">
                      {t("team.add")}
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => openSettings("account")}>
                  <User />
                  {t("account.profile")}
                </DropdownMenuItem>
                {billingAvailable ? (
                  <>
                    <DropdownMenuItem onClick={() => openSettings("usage")}>
                      <LayoutGrid />
                      {t("account.usage")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openSettings("billing")}>
                      <CreditCard />
                      {t("account.billing")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleSignOut()}>
                <LogOut />
                {t("account.logOut")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={dispatchDashboardShortcutsOpen}>
                <Keyboard />
                {t("shortcuts.title")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {settingsOpen ? (
        <React.Suspense
          fallback={
            <DashboardSettingsCenterModalSkeleton activeTab={initialTab} />
          }
        >
          <DashboardSettingsCenterModal
            hasTeam={orgList.length > 0}
            initialTab={initialTab}
            initials={initials}
            onOpenChange={setSettingsOpen}
            open={settingsOpen}
            teamName={activeOrg?.name || orgList[0]?.name}
            userEmail={userEmail}
            userImage={userImage}
            userName={userName}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}
