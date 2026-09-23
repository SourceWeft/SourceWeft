"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { authClient } from "../../../lib/auth-client";
import { getSkillMarketAdminMe } from "../../../lib/skill-market-audit";

type AccessState = {
  userId: string;
  pathname: string;
  status: "allowed" | "error";
} | null;

/** One entry check for every /dashboard/admin route. The API remains the authority. */
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

  React.useEffect(() => {
    if (isPending || !userId) return;
    let cancelled = false;

    void getSkillMarketAdminMe()
      .then((result) => {
        if (cancelled) return;
        if (result.isMarketAdmin === true) {
          setAccess({ userId, pathname, status: "allowed" });
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
          setAccess({ userId, pathname, status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isPending, pathname, retry, router, search, userId]);

  if (
    userId &&
    !isPending &&
    access?.userId === userId &&
    access?.pathname === pathname
  ) {
    if (access.status === "allowed") return <>{children}</>;
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
