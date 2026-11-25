"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  AssistantDecisionAction,
  AssistantDecisionItem,
} from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useAssistantDecisions } from "../../../../lib/assistant";
import { memberName } from "./member-name";

const FILTERS = ["all", "create_ticket", "route_to_ticket", "ignore"] as const;

const ACTION_TONE = {
  create_ticket: "text-emerald-600 dark:text-emerald-400",
  route_to_ticket: "text-foreground",
  ignore: "text-muted-foreground",
} as const satisfies Record<AssistantDecisionAction, string>;

/**
 * The router's log: for each event it judged, what it decided and why.
 * This is how a person checks the assistant is doing the right things, not
 * only that it is doing something.
 */
export function DecisionList({
  workspaceId,
  members,
}: {
  workspaceId: string | null;
  members: readonly WorkspaceMember[];
}) {
  const t = useTranslations("dashboardAssistant");
  const locale = useLocale();
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]>("all");
  const query = useAssistantDecisions(
    workspaceId,
    filter === "all" ? null : filter,
    true,
  );
  const items: AssistantDecisionItem[] =
    query.data?.pages.flatMap((page) => page.items) ?? [];
  const format = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-4">
      <div className="flex flex-wrap gap-1.5" role="group">
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              filter === key
                ? "border-foreground/20 bg-muted text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setFilter(key)}
          >
            {t(`decisions.filter.${key}`)}
          </button>
        ))}
      </div>
      {query.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("decisions.loadError")}
        </p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("page.loading")}
        </p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("decisions.empty")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((item) => {
            const author = item.trigger.authorUserId
              ? memberName(members, item.trigger.authorUserId)
              : null;
            return (
              <li
                key={item.id}
                data-decision-id={item.id}
                className="flex flex-col gap-1 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className={cn("font-medium", ACTION_TONE[item.action])}>
                    {t(`decisions.action.${item.action}`)}
                  </span>
                  <span>
                    {t(`decisions.source.${item.trigger.sourceKind}`)}
                    {author ? ` · ${author}` : ""}
                  </span>
                  <time dateTime={item.createdAt}>
                    {format.format(new Date(item.createdAt))}
                  </time>
                </div>
                <p className="line-clamp-3 break-words text-sm">
                  {item.trigger.text}
                </p>
                {item.reason ? (
                  <p className="break-words text-xs leading-relaxed text-muted-foreground">
                    {t("decisions.why", { reason: item.reason })}
                  </p>
                ) : null}
                {item.ticket ? (
                  <Link
                    href={`/dashboard/assistant?ticket=${encodeURIComponent(item.ticket.id)}`}
                    className="text-xs text-primary hover:underline"
                  >
                    {t("decisions.ticket", { title: item.ticket.title })}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("decisions.loadOlder")}
        </Button>
      ) : null}
    </div>
  );
}
