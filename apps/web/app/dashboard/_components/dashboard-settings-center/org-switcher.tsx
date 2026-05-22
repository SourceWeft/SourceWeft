"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../../lib/auth-client";
import {
  getPersonalOrganization,
  getVisibleTeamOrganizations,
  isPersonalOrganization,
} from "../dashboard-team-selector-shared";
import type { BillingOrg } from "./types";

export function OrgSwitcher({ className }: { className?: string }) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [open, setOpen] = React.useState(false);
  const activeOrgRecord = activeOrg as BillingOrg | null | undefined;

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const personalOrg = getPersonalOrganization((orgs ?? []) as BillingOrg[]);
  const isPersonalActive =
    !activeOrgRecord || isPersonalOrganization(activeOrgRecord);

  async function handleSwitch(orgId: string) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
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
            {isPersonalActive
              ? (personalOrg?.name ?? activeOrgRecord?.name)
              : activeOrgRecord?.name}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        {personalOrg ? (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
              isPersonalActive && "bg-accent/60",
            )}
            onClick={() => void handleSwitch(personalOrg.id)}
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
