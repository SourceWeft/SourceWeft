"use client";

import { useAuthenticate } from "@better-auth-ui/react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { authClient } from "../../../lib/auth-client";
import { RawImage } from "../../_components/raw-image";

export type MobileMeUser = {
  email?: string;
  image?: string | null;
  name?: string;
};

export function getMobileMeInitials(name?: string, email?: string) {
  const value = name || email || "SW";
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function useMobileMeUser(): MobileMeUser | undefined {
  const authState = useAuthenticate(authClient);
  return (authState.data as { user?: MobileMeUser } | null | undefined)?.user;
}

export function MobileMeAvatar({
  className,
  user,
}: {
  className?: string;
  user?: MobileMeUser;
}) {
  const t = useTranslations("dashboardNav");
  if (user?.image) {
    return (
      <RawImage
        alt={user.name || t("account.userAvatarAlt")}
        className={cn("shrink-0 rounded-full object-cover", className)}
        src={user.image}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary",
        className,
      )}
    >
      {getMobileMeInitials(user?.name, user?.email) || "SW"}
    </span>
  );
}

/** The drawer's account row on phones: it opens the Me page. */
export function DashboardMobileMeEntry({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations("dashboardNav");
  const user = useMobileMeUser();
  return (
    <button
      aria-label={t("nav.me")}
      className="flex h-12 w-full items-center gap-3 rounded-xl px-2 text-left transition-colors hover:bg-sidebar-accent active:bg-sidebar-accent"
      onClick={onOpen}
      type="button"
    >
      <MobileMeAvatar className="size-8 text-xs" user={user} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-sidebar-foreground">
          {user?.name || t("account.sourceweftUser")}
        </span>
        {user?.email ? (
          <span className="block truncate text-xs text-muted-foreground">
            {user.email}
          </span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
