"use client";

import type { ReactNode } from "react";
import { useAuthenticate } from "@daveyplate/better-auth-ui";
import { useRouter } from "next/navigation";
import { authClient } from "../../../lib/auth-client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import { cn } from "@sourceweft/ui-web/lib/utils";

export type DashboardTeamItem = {
  id: string;
  name: string;
  metadata?: unknown;
  slug?: string;
  isPersonal?: boolean;
};

type DashboardTeamOrganization = {
  id: string;
  metadata?: unknown;
  name: string;
  slug?: string;
};

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

type SourceweftOrganizationMetadata = {
  sourceweft?: {
    kind?: "personal" | "team";
  };
};

function parseOrganizationMetadata(metadata: unknown) {
  if (!metadata) return {};
  if (typeof metadata === "object") {
    return metadata as SourceweftOrganizationMetadata;
  }
  if (typeof metadata !== "string") return {};

  try {
    let parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }

    return parsed && typeof parsed === "object"
      ? (parsed as SourceweftOrganizationMetadata)
      : {};
  } catch {
    return {};
  }
}

export function isPersonalOrganization(org: { metadata?: unknown }) {
  return parseOrganizationMetadata(org.metadata).sourceweft?.kind === "personal";
}

export function getVisibleTeamOrganizations<T extends DashboardTeamOrganization>(
  orgs: T[],
) {
  return orgs.filter((org) => !isPersonalOrganization(org));
}

export function getPersonalOrganization<T extends DashboardTeamOrganization>(
  orgs: T[],
) {
  return orgs.find(isPersonalOrganization) ?? null;
}

export function useDashboardTeamSelector() {
  const router = useRouter();
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | {
        user?: { email?: string; image?: string | null; name?: string };
      }
    | null
    | undefined;
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const allOrgs = (orgs ?? []) as Array<{
    id: string;
    metadata?: unknown;
    name: string;
    slug?: string;
  }>;
  const personalOrg = getPersonalOrganization(allOrgs);
  const orgList = getVisibleTeamOrganizations(allOrgs);
  const user: DashboardTeamUser = {
    email: sessionState?.user?.email,
    image: sessionState?.user?.image,
    initials: getUserInitials(sessionState?.user?.name, sessionState?.user?.email),
    name: sessionState?.user?.name,
  };
  const items: DashboardTeamItem[] = [
    ...(personalOrg
      ? [
          {
            id: personalOrg.id,
            isPersonal: true,
            metadata: personalOrg.metadata,
            name: personalOrg.name,
            slug: personalOrg.slug,
          },
        ]
      : []),
    ...orgList.map((org) => ({
      id: org.id,
      metadata: org.metadata,
      name: org.name,
      slug: org.slug,
    })),
  ];

  const currentItem = (activeOrg
    ? items.find((item) => item.id === activeOrg.id) ?? items[0]
    : personalOrg
      ? items.find((item) => item.id === personalOrg.id)
      : items[0]) ?? null;

  async function switchTeam(item: DashboardTeamItem) {
    await authClient.organization.setActive({
      organizationId: item.id,
    });
    router.refresh();
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
