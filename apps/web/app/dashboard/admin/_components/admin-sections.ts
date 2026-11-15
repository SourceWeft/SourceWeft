import type { AdminOverviewResponse } from "@sourceweft/contracts";
import {
  Flag,
  LayoutDashboard,
  LibraryBig,
  List,
  Newspaper,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { McpIcon, SkillIcon } from "../../../_components/site-icons";

export const ADMIN_HOME_HREF = "/dashboard/admin";

type AdminIcon = LucideIcon | ComponentType<{ className?: string }>;

export type AdminSection = {
  /** Message key under `dashboardAdmin.nav.items`. */
  key: string;
  href: string;
  icon: AdminIcon;
  /** Active only on its own address, not on what is nested under it. */
  exact?: boolean;
  /** How many things wait in this section, when it is a work queue. */
  pending?: (overview: AdminOverviewResponse) => number;
};

export type AdminSectionGroup = {
  /** Message key under `dashboardAdmin.nav.groups`. */
  key: string;
  sections: readonly AdminSection[];
};

/** The admin home page: what is waiting, section by section. */
export const ADMIN_OVERVIEW_SECTION: AdminSection = {
  key: "overview",
  href: ADMIN_HOME_HREF,
  icon: LayoutDashboard,
  exact: true,
};

export const ADMIN_SECTION_GROUPS: readonly AdminSectionGroup[] = [
  {
    key: "market",
    sections: [
      {
        key: "mcpReview",
        href: "/dashboard/admin/market/mcp-review",
        icon: McpIcon,
        pending: (overview) => overview.pending.mcpReview,
      },
      {
        key: "skillReview",
        href: "/dashboard/admin/market/skill-review",
        icon: SkillIcon,
        // The page holds both skill queues.
        pending: (overview) =>
          overview.pending.skillReview + overview.pending.skillListing,
      },
      {
        key: "reports",
        href: "/dashboard/admin/market/reports",
        icon: Flag,
        pending: (overview) => overview.pending.reports,
      },
      { key: "skills", href: "/dashboard/admin/market/skills", icon: List },
      {
        key: "collections",
        href: "/dashboard/admin/market/collections",
        icon: LibraryBig,
      },
    ],
  },
  {
    key: "content",
    sections: [{ key: "blog", href: "/dashboard/admin/blog", icon: Newspaper }],
  },
  {
    key: "system",
    sections: [
      {
        key: "marketSettings",
        href: "/dashboard/admin/market/settings",
        icon: Settings,
      },
    ],
  },
];

/** Where an old Market address with no known tab lands. */
export const ADMIN_DEFAULT_HREF = "/dashboard/admin/market/mcp-review";

/** The addresses the Market tabs had while they were a `?tab=` parameter. */
const LEGACY_MARKET_TABS: Record<string, string> = {
  mcp: "/dashboard/admin/market/mcp-review",
  skills: "/dashboard/admin/market/skill-review",
  reports: "/dashboard/admin/market/reports",
  all: "/dashboard/admin/market/skills",
  collections: "/dashboard/admin/market/collections",
  settings: "/dashboard/admin/market/settings",
};

export function legacyMarketTabHref(tab: string | null | undefined): string {
  return tab && Object.hasOwn(LEGACY_MARKET_TABS, tab)
    ? LEGACY_MARKET_TABS[tab]!
    : ADMIN_DEFAULT_HREF;
}

/** True on the section's own address and on anything nested under it. */
export function isAdminSectionActive(
  pathname: string,
  section: Pick<AdminSection, "href" | "exact">,
): boolean {
  return (
    pathname === section.href ||
    (!section.exact && pathname.startsWith(`${section.href}/`))
  );
}
