"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { useAdminOverview } from "./admin-overview-context";
import { ADMIN_SECTION_GROUPS, type AdminSection } from "./admin-sections";
import { AdminError, AdminHeader, AdminLoading } from "./admin-ui";

const QUEUES: readonly AdminSection[] = ADMIN_SECTION_GROUPS.flatMap((group) =>
  group.sections.filter((section) => section.pending),
);

const BLOG_HREF = "/dashboard/admin/blog";

/** The admin home page: every work queue with how much is waiting in it. */
export function AdminOverview() {
  const t = useTranslations("dashboardAdmin");
  const { overview, failed, refresh } = useAdminOverview();
  const total = overview
    ? QUEUES.reduce((sum, section) => sum + section.pending!(overview), 0)
    : 0;

  return (
    <>
      <AdminHeader
        actions={
          <Button
            aria-label={t("overview.refresh")}
            onClick={refresh}
            size="icon"
            variant="outline"
          >
            <RefreshCw className="size-4" />
          </Button>
        }
        description={t("overview.description")}
        title={t("overview.title")}
      />

      {failed ? (
        <AdminError
          action={
            <Button onClick={refresh} size="sm" variant="outline">
              {t("overview.retry")}
            </Button>
          }
          className="mt-6"
        >
          {t("overview.loadFailed")}
        </AdminError>
      ) : null}

      {!overview ? (
        failed ? null : (
          <AdminLoading className="mt-4">{t("overview.loading")}</AdminLoading>
        )
      ) : (
        <>
          <p
            className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            {total === 0 ? (
              <CheckCircle2 aria-hidden className="size-4 text-emerald-500" />
            ) : null}
            {t("overview.summary", { count: total })}
          </p>

          <h2 className="mt-8 text-sm font-medium text-muted-foreground">
            {t("overview.queues")}
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {QUEUES.map((section) => {
              const pending = section.pending!(overview);
              return (
                <li key={section.href}>
                  <Link
                    className="group flex h-full flex-col rounded-xl border p-4 transition-colors hover:bg-muted/50"
                    data-testid={`admin-overview-${section.key}`}
                    href={section.href}
                  >
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <section.icon className="size-4 shrink-0" />
                      {t(`nav.items.${section.key}`)}
                      <ArrowRight
                        aria-hidden
                        className="ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </span>
                    <span
                      className={cn(
                        "mt-3 text-3xl font-semibold tabular-nums tracking-tight",
                        pending === 0 && "text-muted-foreground",
                      )}
                    >
                      {pending}
                    </span>
                    <span className="mt-1 text-xs text-muted-foreground">
                      {t(`overview.hints.${section.key}`, {
                        review: overview.pending.skillReview,
                        listing: overview.pending.skillListing,
                      })}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <h2 className="mt-8 text-sm font-medium text-muted-foreground">
            {t("overview.content")}
          </h2>
          <Link
            className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border p-4 transition-colors hover:bg-muted/50"
            data-testid="admin-overview-blog"
            href={BLOG_HREF}
          >
            <span className="text-sm">{t("nav.items.blog")}</span>
            <span className="text-sm text-muted-foreground">
              {t("overview.blogDrafts", { count: overview.blog.drafts })}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("overview.blogPublished", { count: overview.blog.published })}
            </span>
          </Link>
        </>
      )}
    </>
  );
}
