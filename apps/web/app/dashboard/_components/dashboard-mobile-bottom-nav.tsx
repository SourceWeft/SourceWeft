"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquareText,
  User,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { McpIcon, SkillIcon } from "../../_components/site-icons";
import { useDashboardMobileNav } from "./dashboard-mobile-nav-state";

const items = [
  {
    labelKey: "nav.chat",
    href: "/dashboard/chat",
    icon: MessageSquareText,
    match: (pathname: string) => pathname.startsWith("/dashboard/chat"),
  },
  {
    labelKey: "nav.overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    match: (pathname: string) => pathname === "/dashboard",
  },
  {
    labelKey: "nav.skills",
    href: "/dashboard/skills",
    icon: SkillIcon,
    match: (pathname: string) => pathname.startsWith("/dashboard/skills"),
  },
  {
    labelKey: "nav.mcp",
    href: "/dashboard/mcp",
    icon: McpIcon,
    match: (pathname: string) => pathname.startsWith("/dashboard/mcp"),
  },
] as const;

export function DashboardMobileBottomNav() {
  const t = useTranslations("dashboardNav");
  const pathname = usePathname();
  const { openMain, openMe, view } = useDashboardMobileNav();
  const isMeActive = view === "me" || view === "observability";

  return (
    // Anchored to the shell rather than the layout viewport: the shell is sized in
    // `dvh`, which shrinks when the keyboard opens, while a `fixed` element stays put —
    // the two disagree and leave the composer floating above the bar.
    <nav className="absolute inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 backdrop-blur md:hidden">
      <div className="grid grid-cols-5 gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = view === "main" && item.match(pathname);
          return (
            <Link
              className={cn(
                "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active && "bg-accent text-foreground",
              )}
              href={item.href}
              key={item.href}
              onClick={openMain}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{t(item.labelKey)}</span>
            </Link>
          );
        })}

        <button
          className={cn(
            "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            isMeActive && "bg-accent text-foreground",
          )}
          onClick={openMe}
          type="button"
        >
          <User className="h-4 w-4" />
          <span className="truncate">{t("nav.me")}</span>
        </button>
      </div>
    </nav>
  );
}
