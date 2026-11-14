"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { authClient } from "../../../lib/auth-client";
import { useDesktopTitlebar } from "../../../lib/desktop-titlebar";
import { getSkillMarketAdminMe } from "../../../lib/skill-market-audit";
import { AdminNav } from "./_components/admin-nav";

type AccessState = {
  userId: string;
  status: "allowed" | "error";
} | null;

/**
 * The admin shell and the one entry check for every /dashboard/admin route.
 * The check runs again on each section, behind the shell, so moving between
 * sections does not blank the page. The API remains the authority.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("dashboardAdmin");
  const { data, isPending } = authClient.useSession();
  const userId = data?.user?.id;
  const pathname = usePathname() ?? "/dashboard/admin";
  const search = useSearchParams().toString();
  const router = useRouter();
  const [access, setAccess] = React.useState<AccessState>(null);
  const [retry, setRetry] = React.useState(0);
  // The workspace sidebar is hidden here, so this shell leaves the room the
  // macOS window controls need.
  const desktopTitlebar = useDesktopTitlebar();

  React.useEffect(() => {
    if (isPending || !userId) return;
    let cancelled = false;

    void getSkillMarketAdminMe()
      .then((result) => {
        if (cancelled) return;
        if (result.isMarketAdmin === true) {
          setAccess({ userId, status: "allowed" });
        } else {
          router.replace("/dashboard");
        }
      })
      .catch((error: { status?: number }) => {
        if (cancelled) return;
        if (error.status === 401) {
          const destination = search ? `${pathname}?${search}` : pathname;
          router.replace(
            `/auth/sign-in?redirectTo=${encodeURIComponent(destination)}`,
          );
        } else if (error.status === 403) {
          router.replace("/dashboard");
        } else {
          // A failed re-check while moving between sections keeps the shell
          // up; the API still refuses anything this user may not do.
          setAccess((current) =>
            current?.userId === userId && current.status === "allowed"
              ? current
              : { userId, status: "error" },
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isPending, pathname, retry, router, search, userId]);

  if (userId && !isPending && access?.userId === userId) {
    if (access.status === "allowed") {
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {desktopTitlebar ? (
            <div
              className="h-10 shrink-0 select-none"
              data-desktop-drag-region
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
            <AdminNav pathname={pathname} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {children}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-destructive">{t("accessCheckFailed")}</p>
        <Button
          onClick={() => {
            setAccess(null);
            setRetry((value) => value + 1);
          }}
          variant="outline"
        >
          {t("retryAccessCheck")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
      {t("checkingAccess")}
    </div>
  );
}
