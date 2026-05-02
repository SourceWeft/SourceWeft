"use client";

import type { ReactNode } from "react";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import { authClient } from "../../../lib/auth-client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import { cn } from "@sourceweft/ui-web/lib/utils";

export const PERSONAL_WORKSPACE_LABEL = "Personal workspace";

export type DashboardTeamItem = {
  id: string;
  name: string;
  slug?: string;
  isPersonal?: boolean;
};

type DashboardTeamOrganization = { id: string; name: string; slug?: string };

type DashboardTeamUser = {
  email?: string;
  image?: string | null;
  initials: string;
  name?: string;
};

function getUserInitials(name?: string, email?: string) {
  const value = name || email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function getTeamInitials(name: string) {
  return name
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function isAutoPersonalOrganization(org: { name: string; slug?: string }) {
  return org.name === "Personal" && org.slug?.startsWith("personal-");
}

export function getVisibleTeamOrganizations<T extends DashboardTeamOrganization>(
  orgs: T[],
) {
  return orgs.filter((org) => !isAutoPersonalOrganization(org));
}

export function useDashboardTeamSelector() {
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | {
        user?: { email?: string; image?: string | null; name?: string };
      }
    | null
    | undefined;
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{ id: string; name: string; slug?: string }>,
  );
  const user: DashboardTeamUser = {
    email: sessionState?.user?.email,
    image: sessionState?.user?.image,
    initials: getUserInitials(sessionState?.user?.name, sessionState?.user?.email),
    name: sessionState?.user?.name,
  };
  const items: DashboardTeamItem[] = [
    { id: "personal", name: PERSONAL_WORKSPACE_LABEL, isPersonal: true },
    ...orgList.map((org) => ({ id: org.id, name: org.name, slug: org.slug })),
  ];

  const currentItem = (activeOrg
    ? items.find((item) => item.id === activeOrg.id) ?? items[0]
    : items[0]) ?? {
    id: "personal",
    name: PERSONAL_WORKSPACE_LABEL,
    isPersonal: true,
  };

  async function switchTeam(item: DashboardTeamItem) {
    await authClient.organization.setActive({
      organizationId: item.isPersonal ? null : item.id,
    });
  }

  return {
    activeOrg,
    currentItem,
    items,
    orgList,
    switchTeam,
    user,
  };
}

type DashboardTeamIdentityVariant = "header" | "menu";

const identityVariantClasses: Record<
  DashboardTeamIdentityVariant,
  { avatar: string; fallback: string; wrapper: string }
> = {
  header: {
    avatar: "h-4 w-4 rounded-full",
    fallback: "rounded-full text-[10px] font-semibold",
    wrapper:
      "flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
  },
  menu: {
    avatar: "size-4 rounded-full",
    fallback: "rounded-full text-[10px]",
    wrapper:
      "flex size-6 shrink-0 items-center justify-center rounded-full border",
  },
};

export function DashboardTeamDisplay({
  endSlot,
  item,
  labelClassName,
  variant,
  user,
}: {
  endSlot?: ReactNode;
  item: DashboardTeamItem;
  labelClassName?: string;
  variant: DashboardTeamIdentityVariant;
  user: DashboardTeamUser;
}) {
  const classes = identityVariantClasses[variant];
  const fallback = item.isPersonal ? user.initials : getTeamInitials(item.name);

  return (
    <>
      <div className={classes.wrapper}>
        <Avatar className={classes.avatar}>
          {item.isPersonal ? (
            <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User"} />
          ) : null}
          <AvatarFallback className={cn(classes.fallback)}>{fallback}</AvatarFallback>
        </Avatar>
      </div>
      <span className={cn("truncate", labelClassName)}>{item.name}</span>
      {endSlot}
    </>
  );
}
