"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { DropdownMenuItem } from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { getSkillMarketAdminMe } from "../../../lib/skill-market-audit";
import { skillMarketAdminCopy } from "../admin/market/_components/skill-market-admin-copy";

export const MARKET_ADMIN_HREF = "/dashboard/admin/market";

// One question per page load, however many places render the link.
let adminCheck: Promise<boolean> | null = null;

function isMarketAdmin(): Promise<boolean> {
  adminCheck ??= getSkillMarketAdminMe()
    .then((result) => result.isMarketAdmin === true)
    .catch(() => {
      // Ask again next time: a network blip must not hide it for good.
      adminCheck = null;
      return false;
    });
  return adminCheck;
}

/** For tests: forget the cached answer. */
export function resetMarketAdminCheck() {
  adminCheck = null;
}

export function useIsMarketAdmin(): boolean {
  const [admin, setAdmin] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void isMarketAdmin().then((value) => {
      if (!cancelled) setAdmin(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return admin;
}

/**
 * The sidebar's "Market admin" entry, for market admins only; nothing for
 * everyone else. `variant="link"` matches the sidebar's main links;
 * `variant="menu-item"` goes inside the "More" dropdown's content.
 */
export function MarketAdminNavLink({
  variant = "link",
  onNavigate,
}: {
  variant?: "link" | "menu-item";
  onNavigate?: () => void;
}) {
  const admin = useIsMarketAdmin();
  const pathname = usePathname() ?? "";
  if (!admin) return null;
  const active = pathname.startsWith(MARKET_ADMIN_HREF);
  const label = skillMarketAdminCopy.nav.marketAdmin;

  if (variant === "menu-item") {
    return (
      <DropdownMenuItem asChild>
        <Link
          aria-current={active ? "page" : undefined}
          href={MARKET_ADMIN_HREF}
          onClick={onNavigate}
        >
          <ShieldCheck className="size-4" />
          {label}
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      href={MARKET_ADMIN_HREF}
      onClick={onNavigate}
    >
      <ShieldCheck className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}
