"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { useAdminOverview } from "./admin-overview-context";
import {
  ADMIN_OVERVIEW_SECTION,
  ADMIN_SECTION_GROUPS,
  isAdminSectionActive,
  type AdminSection,
} from "./admin-sections";

const linkClass =
  "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

/**
 * The admin area's own navigation: a column beside the page on wide screens,
 * one scrolling row above it on narrow ones.
 */
export function AdminNav({ pathname }: { pathname: string }) {
  const t = useTranslations("dashboardAdmin");
  const { overview } = useAdminOverview();

  function sectionLink(section: AdminSection) {
    const active = isAdminSectionActive(pathname, section);
    const pending = overview && section.pending ? section.pending(overview) : 0;
    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={cn(
          linkClass,
          active &&
            "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )}
        href={section.href}
        key={section.href}
      >
        <section.icon className="size-4 shrink-0" />
        <span className="whitespace-nowrap">
          {t(`nav.items.${section.key}`)}
        </span>
        {pending > 0 ? (
          <span
            aria-label={t("nav.pending", { count: pending })}
            className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium leading-5 text-primary-foreground tabular-nums"
            data-testid="admin-nav-pending"
          >
            {pending > 99 ? "99+" : pending}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <nav
      aria-label={t("nav.label")}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-sidebar-border bg-sidebar px-2 py-2 md:w-56 md:flex-col md:items-stretch md:gap-0 md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r md:px-3 md:py-4"
    >
      <p className="hidden px-2.5 pb-2 text-sm font-semibold text-sidebar-foreground md:block">
        {t("nav.title")}
      </p>
      {sectionLink(ADMIN_OVERVIEW_SECTION)}
      {ADMIN_SECTION_GROUPS.map((group) => (
        <div
          className="flex shrink-0 items-center gap-1 md:flex-col md:items-stretch md:gap-0.5"
          key={group.key}
        >
          <p className="hidden px-2.5 pb-1 pt-4 text-xs text-sidebar-foreground/50 md:block">
            {t(`nav.groups.${group.key}`)}
          </p>
          {group.sections.map(sectionLink)}
        </div>
      ))}
      <Link
        className={cn(linkClass, "order-first md:order-last md:mt-auto")}
        href="/dashboard"
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="whitespace-nowrap">{t("nav.backToApp")}</span>
      </Link>
    </nav>
  );
}
