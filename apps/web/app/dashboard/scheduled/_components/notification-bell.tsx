"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import {
  useNotificationMutations,
  useUnreadNotificationCount,
} from "../../../../lib/scheduled-tasks";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { NotificationList } from "./notification-list";

/** The rail's bell: the unread count, and the latest notifications in a popover. */
export function NotificationBell() {
  const t = useTranslations("dashboardScheduled");
  const { workspaceId } = useDashboardChatState();
  const [open, setOpen] = React.useState(false);
  const unread = useUnreadNotificationCount(workspaceId).data ?? 0;
  const { markAllRead } = useNotificationMutations(workspaceId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative size-9 text-muted-foreground"
          aria-label={
            unread > 0
              ? t("bell.labelUnread", { count: unread })
              : t("bell.label")
          }
          title={t("bell.label")}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <span
              data-testid="notification-unread"
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-sm font-medium">{t("bell.title")}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            {t("inbox.markAllRead")}
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <NotificationList
            workspaceId={workspaceId}
            limit={10}
            onNavigate={() => setOpen(false)}
          />
        </div>
        <div className="border-t border-border p-2">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link
              href="/dashboard/scheduled?tab=inbox"
              onClick={() => setOpen(false)}
            >
              {t("bell.viewAll")}
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
