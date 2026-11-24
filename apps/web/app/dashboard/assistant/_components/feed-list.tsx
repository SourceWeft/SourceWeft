"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  AssistantFeedItem,
  AssistantTicket,
  FeedTicketEvent,
} from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { memberName } from "./member-name";

/** The colour of an event's label and of the rule beside its update. */
const EVENT_TONE = {
  created: { text: "text-muted-foreground", rule: "border-border" },
  ready: {
    text: "text-emerald-600 dark:text-emerald-400",
    rule: "border-emerald-500/50",
  },
  waiting: {
    text: "text-amber-600 dark:text-amber-400",
    rule: "border-amber-500/60",
  },
  blocked: { text: "text-destructive", rule: "border-destructive/60" },
  failed: { text: "text-destructive", rule: "border-destructive/60" },
  dropped: { text: "text-muted-foreground", rule: "border-border" },
} as const satisfies Record<FeedTicketEvent, { text: string; rule: string }>;

/** A report longer than this starts folded, so one long answer does not push the rest away. */
const FOLD_CHARS = 280;
const FOLD_LINES = 6;

function FoldedText({ text }: { text: string }) {
  const t = useTranslations("dashboardAssistant");
  const [open, setOpen] = React.useState(false);
  const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-[15px] leading-relaxed md:text-sm",
          long && !open && "line-clamp-6",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:py-1"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("feed.showLess") : t("feed.showMore")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The shared timeline: member messages, the assistant's replies and ticket
 * updates, mixed and read oldest first like a conversation. `items` arrive
 * newest first, as the API pages them.
 *
 * It owns its scroll area and stays pinned to the newest item, unless the
 * reader has scrolled up to look at something earlier.
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
  const scroller = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  // The newest item decides whether to follow: loading earlier messages adds
  // to the top and must not yank the reader down.
  const newestId = ordered.at(-1)?.id ?? null;

  React.useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [newestId]);

  if (ordered.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
        {t("feed.empty")}
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < 120;
      }}
    >
      <div className="flex flex-col gap-5 py-3">
        {hasOlder ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-center text-muted-foreground"
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            {t("feed.loadOlder")}
          </Button>
        ) : null}
        <ol className="flex flex-col gap-5">
          {ordered.map((item) => {
            const ticket = item.ticketId
              ? ticketsById.get(item.ticketId)
              : null;
            const at = new Date(item.createdAt);
            const time = Number.isNaN(at.getTime()) ? null : (
              <time
                dateTime={item.createdAt}
                className="text-[11px] text-muted-foreground"
              >
                {format.format(at)}
              </time>
            );

            if (item.kind === "member_message") {
              const own = item.authorUserId === viewerId;
              const author = own
                ? t("feed.you")
                : (memberName(members, item.authorUserId) ??
                  t("feed.formerMember"));
              return (
                <li
                  key={item.id}
                  data-feed-id={item.id}
                  className={cn(
                    "flex flex-col gap-1",
                    own ? "items-end" : "items-start",
                  )}
                >
                  <div className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {author}
                    </span>
                    {time}
                  </div>
                  <div
                    className={cn(
                      "max-w-[90%] rounded-2xl px-3.5 py-2 md:max-w-[78%]",
                      own
                        ? "rounded-tr-md bg-primary/10"
                        : "rounded-tl-md bg-muted",
                    )}
                  >
                    <FoldedText text={item.text} />
                  </div>
                </li>
              );
            }

            if (item.kind === "router_message") {
              return (
                <li
                  key={item.id}
                  data-feed-id={item.id}
                  className="flex max-w-[95%] flex-col gap-1 md:max-w-[85%]"
                >
                  <div className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t("feed.assistant")}
                    </span>
                    {time}
                  </div>
                  <div className="px-1">
                    <FoldedText text={item.text} />
                  </div>
                </li>
              );
            }

            const event = item.ticketEvent;
            const tone = event ? EVENT_TONE[event] : EVENT_TONE.created;
            // A new ticket's text is its title, already in the header when the
            // ticket is known; older items (no event) keep their full text.
            const text = event === "created" && ticket ? null : item.text;
            return (
              <li
                key={item.id}
                data-feed-id={item.id}
                className={cn(
                  "flex max-w-[95%] flex-col gap-1.5 border-l-2 pl-3 md:max-w-[85%]",
                  tone.rule,
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="min-w-0 break-words text-sm font-medium text-foreground">
                    {ticket
                      ? t("feed.ticket", { title: ticket.title })
                      : t("feed.assistant")}
                  </span>
                  {event ? (
                    <span className={cn("font-medium", tone.text)}>
                      {t(`feed.event.${event}`)}
                    </span>
                  ) : null}
                  {time}
                </div>
                {text ? <FoldedText text={text} /> : null}
                {ticket ? (
                  <Link
                    href={`/dashboard/chat/${encodeURIComponent(ticket.workerThreadId)}`}
                    className="inline-flex items-center gap-0.5 self-start text-xs text-muted-foreground hover:text-foreground max-md:py-1"
                  >
                    {t("feed.openConversation")}
                    <ChevronRight className="size-3.5" aria-hidden />
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
