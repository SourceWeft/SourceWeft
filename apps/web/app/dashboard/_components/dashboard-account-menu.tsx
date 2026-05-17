"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import {
  CreditCard,
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
import { DashboardRailTeamSwitcher } from "./dashboard-team-switcher";
import {
  DashboardTeamDisplay,
  type DashboardTeamItem,
  useDashboardTeamSelector,
} from "./dashboard-team-selector-shared";
import { dispatchDashboardShortcutsOpen } from "./dashboard-shortcuts";

const DashboardSettingsCenterModal = dynamic(
  () =>
    import("./dashboard-settings-center-modal").then(
      (module) => module.DashboardSettingsCenterModal,
    ),
  { ssr: false },
);

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
}: {
  settingsRequest?: { id: number; tab: SettingsCenterTab } | null;
}) {
  const { isMobile } = useSidebar();
  const authState = useAuthenticate();
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
      toast.error("Failed to switch team.");
    }
  }

  async function handleSignOut() {
    await authClient.signOut();
  }

  return (
    <>
      <SidebarMenu className="items-center gap-2">
        <SidebarMenuItem>
          <DashboardRailTeamSwitcher onAddTeam={() => openSettings("team")} />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-sm font-semibold text-foreground shadow-xs"
                type="button"
              >
                {userImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={userName ?? "User"}
                    className="h-8 w-8 rounded-lg object-cover"
                    src={userImage}
                  />
                ) : (
                  <span>{initials || "SW"}</span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage
                      src={userImage ?? undefined}
                      alt={userName ?? "User"}
                    />
                    <AvatarFallback className="rounded-lg">
                      {initials || "SW"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {userName || "SourceWeft User"}
                    </span>
                    <span className="truncate text-xs">
                      {userEmail || "Signed in"}
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
                      Add team
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => openSettings("account")}>
                  <User />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openSettings("usage")}>
                  <LayoutGrid />
                  Usage
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openSettings("billing")}>
                  <CreditCard />
                  Billing
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleSignOut()}>
                <LogOut />
                Log out
              </DropdownMenuItem>
              <DropdownMenuItem onClick={dispatchDashboardShortcutsOpen}>
                <Keyboard />
                Keyboard shortcuts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

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
    </>
  );
}
