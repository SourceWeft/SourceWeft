import {
  Flag,
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
};

export type AdminSectionGroup = {
  /** Message key under `dashboardAdmin.nav.groups`. */
  key: string;
  sections: readonly AdminSection[];
};

export const ADMIN_SECTION_GROUPS: readonly AdminSectionGroup[] = [
  {
    key: "market",
    sections: [
      {
        key: "mcpReview",
        href: "/dashboard/admin/market/mcp-review",
        icon: McpIcon,
      },
      {
        key: "skillReview",
        href: "/dashboard/admin/market/skill-review",
        icon: SkillIcon,
      },
      { key: "reports", href: "/dashboard/admin/market/reports", icon: Flag },
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

/** Where the admin area opens until it has an overview of its own. */
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
export function isAdminSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
