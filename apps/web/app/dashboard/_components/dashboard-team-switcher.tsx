"use client";

import * as React from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
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

export function DashboardTeamSwitcher({
  className,
  onAddTeam,
  size = "default",
}: DashboardTeamSwitcherProps) {
  const { activeOrg, currentItem, items, switchTeam, user } =
    useDashboardTeamSelector();
  const [open, setOpen] = React.useState(false);

  async function handleSwitch(item: DashboardTeamItem) {
    try {
      await switchTeam(item);
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
            size === "sm" && "px-2 py-1",
            className,
          )}
          type="button"
        >
          <DashboardTeamDisplay
            endSlot={<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
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
            const isActive =
              item.isPersonal && !activeOrg ? true : activeOrg?.id === item.id;

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
