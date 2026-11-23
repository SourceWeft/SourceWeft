"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Bot, ListChecks } from "lucide-react";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  AssistantFeedItem,
  AssistantTicket,
} from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { memberName } from "./member-name";

/**
 * The shared timeline: member messages, the assistant's replies and ticket
 * updates, mixed and read oldest first like a conversation. `items` arrive
 * newest first, as the API pages them.
 */
export function FeedList({
  items,
  tickets,
  members,
  viewerId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  items: readonly AssistantFeedItem[];
  tickets: readonly AssistantTicket[];
  members: readonly WorkspaceMember[];
  viewerId: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const t = useTranslations("dashboardAssistant");
  const locale = useLocale();
  const ticketsById = React.useMemo(
    () => new Map(tickets.map((ticket) => [ticket.id, ticket])),
    [tickets],
  );
  const ordered = React.useMemo(() => [...items].reverse(), [items]);
  const format = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  if (ordered.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">{t("feed.empty")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasOlder ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {t("feed.loadOlder")}
        </Button>
      ) : null}
      <ol className="flex flex-col gap-3">
        {ordered.map((item) => {
          const ticket = item.ticketId ? ticketsById.get(item.ticketId) : null;
          const own =
            item.kind === "member_message" && item.authorUserId === viewerId;
          const author =
            item.kind === "member_message"
              ? own
                ? t("feed.you")
                : (memberName(members, item.authorUserId) ??
                  t("feed.formerMember"))
              : item.kind === "router_message"
                ? t("feed.assistant")
                : ticket
                  ? t("feed.ticket", { title: ticket.title })
                  : t("feed.assistant");
          const Icon = item.kind === "ticket_update" ? ListChecks : Bot;
          const at = new Date(item.createdAt);
          return (
            <li
              key={item.id}
              data-feed-id={item.id}
              className={cn(
                "flex max-w-[85%] flex-col gap-1 rounded-xl border px-3 py-2",
                own
                  ? "self-end border-primary/30 bg-primary/5"
                  : item.kind === "member_message"
                    ? "self-start border-border bg-card"
                    : "self-start border-border bg-muted/40",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                {item.kind === "member_message" ? null : (
                  <Icon className="size-3.5" aria-hidden />
                )}
                <span className="font-medium text-foreground">{author}</span>
                {Number.isNaN(at.getTime()) ? null : (
                  <time dateTime={item.createdAt}>{format.format(at)}</time>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">
                {item.text}
              </p>
              {item.kind === "ticket_update" && ticket ? (
                <Link
                  href={`/dashboard/chat/${encodeURIComponent(ticket.workerThreadId)}`}
                  className="text-xs underline underline-offset-2"
                >
                  {t("feed.openConversation")}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
