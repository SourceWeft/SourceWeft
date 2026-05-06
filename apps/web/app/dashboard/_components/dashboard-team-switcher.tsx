"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  GalleryVerticalEnd,
  Plus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@sourceweft/ui-web/components/ui/sidebar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import {
  DashboardTeamDisplay,
  type DashboardTeamItem,
  useDashboardTeamSelector,
} from "./dashboard-team-selector-shared";

interface DashboardTeamSwitcherProps {
  className?: string;
  onAddTeam?: () => void;
  size?: "sm" | "default";
}

function isTeamItemActive(
  activeOrg: { id?: string } | null | undefined,
  item: DashboardTeamItem,
) {
  return item.isPersonal && !activeOrg ? true : activeOrg?.id === item.id;
}

export function DashboardTeamSwitcher({
  className,
  onAddTeam,
  size = "default",
}: DashboardTeamSwitcherProps) {
  const { activeOrg, currentItem, items, switchTeam, user } =
    useDashboardTeamSelector();
  const [open, setOpen] = React.useState(false);

  if (!currentItem) {
    return null;
  }

  async function handleSwitch(item: DashboardTeamItem) {
    try {
      await switchTeam(item);
      setOpen(false);
    } catch {
      toast.error("Failed to switch team.");
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50",
            size === "sm" && "px-2 py-1",
            className,
          )}
          type="button"
        >
          <DashboardTeamDisplay
            endSlot={
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            }
            item={currentItem}
            labelClassName="max-w-[120px] text-sm text-foreground"
            user={user}
            variant="header"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        <div className="py-0.5">
          {items.map((item) => {
            const isActive = isTeamItemActive(activeOrg, item);

            return (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  isActive && "bg-accent/60",
                )}
                key={item.id}
                onClick={() => void handleSwitch(item)}
                type="button"
              >
                <DashboardTeamDisplay
                  endSlot={
                    isActive ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                    ) : null
                  }
                  item={item}
                  labelClassName="flex-1"
                  user={user}
                  variant="header"
                />
              </button>
            );
          })}
        </div>
        {onAddTeam ? (
          <>
            <div className="my-1 border-t border-border/60" />
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => {
                setOpen(false);
                onAddTeam();
              }}
              type="button"
            >
              <div className="flex h-5 w-5 items-center justify-center rounded-md border bg-background">
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <span className="text-muted-foreground">Add team</span>
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function DashboardRailTeamSwitcher({
  className,
  onAddTeam,
}: Pick<DashboardTeamSwitcherProps, "className" | "onAddTeam">) {
  const { isMobile } = useSidebar();
  const { activeOrg, currentItem, items, switchTeam, user } =
    useDashboardTeamSelector();

  if (!currentItem) {
    return null;
  }

  const triggerLabel = `Switch team: ${currentItem.name}`;

  async function handleSwitch(item: DashboardTeamItem) {
    try {
      await switchTeam(item);
    } catch {
      toast.error("Failed to switch team.");
    }
  }

  return (
    <SidebarMenu className={cn("items-center", className)}>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label={triggerLabel}
              className="h-10 w-10 justify-center p-1.5 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground [&>svg]:size-3"
              size="lg"
              title={triggerLabel}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-[11px] font-semibold uppercase leading-none text-sidebar-primary-foreground">
                <GalleryVerticalEnd className="size-4" />
              </div>
              <ChevronsUpDown className="absolute -right-1 -top-1 flex size-4 rounded-full border border-sidebar bg-background p-0.5 text-muted-foreground shadow-xs" />
              <span className="sr-only">Team switcher</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Teams
            </DropdownMenuLabel>
            {items.map((item) => {
              const isActive = isTeamItemActive(activeOrg, item);

              return (
                <DropdownMenuItem
                  className={cn("gap-2 p-2", isActive && "bg-accent/60")}
                  key={item.id}
                  onClick={() => void handleSwitch(item)}
                >
                  <DashboardTeamDisplay
                    endSlot={
                      isActive ? (
                        <Check className="size-3.5 shrink-0 text-foreground" />
                      ) : null
                    }
                    item={item}
                    labelClassName="flex-1 text-sm"
                    user={user}
                    variant="menu"
                  />
                </DropdownMenuItem>
              );
            })}
            {onAddTeam ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 p-2" onClick={onAddTeam}>
                  <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                    <Plus className="size-4 text-muted-foreground" />
                  </div>
                  <div className="font-medium text-muted-foreground">
                    Add team
                  </div>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
