"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { NotificationItem } from "@sourceweft/contracts/notifications";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  useNotificationMutations,
  useNotifications,
} from "../../../../lib/scheduled-tasks";
import { useScheduleText } from "./use-schedule-text";

const KNOWN_KINDS = new Set([
  "task_run_succeeded",
  "task_run_failed",
  "task_run_catch_up",
  "task_blocked_quota",
  "task_needs_approval",
  "task_paused_owner_left",
  "task_tools_unavailable",
  "task_paused_repeated_failure",
]);

export function useNotificationText() {
  const t = useTranslations("dashboardScheduled");
  return (item: NotificationItem) => {
    const taskName =
      typeof item.payload.taskName === "string" ? item.payload.taskName : "";
    const kind = KNOWN_KINDS.has(item.kind) ? item.kind : "unknown";
    return t(`notification.${kind}`, { taskName });
  };
}

/** The rows, newest activity first; `limit` caps a short list such as the bell's. */
export function NotificationList({
  workspaceId,
  limit = 20,
  onNavigate,
  className,
}: {
  workspaceId: string | null;
  limit?: number;
  onNavigate?: () => void;
  className?: string;
}) {
  const t = useTranslations("dashboardScheduled");
  const router = useRouter();
  const text = useNotificationText();
  const { formatInstant } = useScheduleText();
  const query = useNotifications(workspaceId, limit);
  const { markRead } = useNotificationMutations(workspaceId);
  const items = query.data?.pages.flatMap((page) => page.notifications) ?? [];

  if (query.isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground">{t("inbox.loading")}</p>
    );
  }
  if (query.isError) {
    return (
      <p className="p-4 text-sm text-destructive" role="alert">
        {t("inbox.loadError")}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">{t("inbox.empty")}</p>
    );
  }

  return (
    <div className={className}>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent",
                !item.readAt && "bg-accent/40",
              )}
              onClick={() => {
                if (!item.readAt) markRead.mutate(item.id);
                onNavigate?.();
                router.push(item.path);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  item.readAt ? "bg-transparent" : "bg-primary",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words">{text(item)}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatInstant(item.lastOccurredAt)}
                  {item.occurrenceCount > 1
                    ? ` · ${t("inbox.repeated", { count: item.occurrenceCount })}`
                    : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <div className="p-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {t("inbox.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
