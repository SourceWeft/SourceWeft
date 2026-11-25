"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  AssistantTicket,
  TicketStage,
} from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useAssistantMutations } from "../../../../lib/assistant";
import { memberName } from "./member-name";
import { useAssistantAction } from "./use-assistant-actions";

/** The open stages, grouped the way a person triages them; ended tickets are not listed. */
const GROUPS = [
  { key: "needsPerson", stages: ["waiting_person"] },
  { key: "inProgress", stages: ["queued", "working"] },
  { key: "idle", stages: ["idle"] },
] as const satisfies ReadonlyArray<{
  key: string;
  stages: readonly TicketStage[];
}>;

/** A stage's icon and label colour; the icon carries the state, the label names it. */
const STAGE_TONE = {
  queued: {
    Icon: Circle,
    icon: "text-muted-foreground/60",
    text: "text-muted-foreground",
  },
  working: {
    Icon: LoaderCircle,
    icon: "animate-spin text-primary",
    text: "text-foreground",
  },
  waiting_person: {
    Icon: CircleAlert,
    icon: "text-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  idle: {
    Icon: CircleDashed,
    icon: "text-muted-foreground/60",
    text: "text-muted-foreground",
  },
  ended: {
    Icon: Circle,
    icon: "text-muted-foreground/40",
    text: "text-muted-foreground",
  },
} as const satisfies Record<
  TicketStage,
  { Icon: LucideIcon; icon: string; text: string }
>;

export function TicketList({
  workspaceId,
  tickets,
  members,
  canWrite,
  viewerId,
  highlightTicketId = null,
}: {
  workspaceId: string | null;
  tickets: readonly AssistantTicket[];
  members: readonly WorkspaceMember[];
  /** Retry and Close are writes; a read-only member is not offered them. */
  canWrite: boolean;
  /** Who is looking. Retry bills the ticket's payer, so only they get it. */
  viewerId: string | null;
  /** The ticket a notification pointed at, scrolled to and marked. */
  highlightTicketId?: string | null;
}) {
  const t = useTranslations("dashboardAssistant");
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const groups = GROUPS.map((group) => ({
    key: group.key,
    tickets: tickets.filter((ticket) =>
      (group.stages as readonly TicketStage[]).includes(ticket.stage),
    ),
  })).filter((group) => group.tickets.length > 0);

  if (groups.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">{t("tickets.empty")}</p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.map((group) => {
        const open = !folded.has(group.key);
        return (
          <section
            key={group.key}
            data-group={group.key}
            className="flex min-w-0 flex-col"
          >
            <button
              type="button"
              aria-expanded={open}
              className="group flex items-center gap-1.5 rounded-md py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() =>
                setFolded((current) => {
                  const next = new Set(current);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })
              }
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  !open && "-rotate-90",
                )}
                aria-hidden
              />
              {t(`tickets.groups.${group.key}`)}
              <span className="tabular-nums text-muted-foreground/70">
                {group.tickets.length}
              </span>
            </button>
            {open ? (
              <ul className="flex min-w-0 flex-col gap-0.5">
                {group.tickets.map((ticket) => (
                  <TicketRow
                    key={ticket.id}
                    ticket={ticket}
                    members={members}
                    workspaceId={workspaceId}
                    canWrite={canWrite}
                    viewerId={viewerId}
                    highlighted={ticket.id === highlightTicketId}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function TicketRow({
  ticket,
  members,
  workspaceId,
  canWrite,
  viewerId,
  highlighted,
}: {
  ticket: AssistantTicket;
  members: readonly WorkspaceMember[];
  workspaceId: string | null;
  canWrite: boolean;
  viewerId: string | null;
  highlighted: boolean;
}) {
  const t = useTranslations("dashboardAssistant");
  const { retryTicket, closeTicket } = useAssistantMutations(workspaceId);
  const { run } = useAssistantAction();
  const ref = React.useRef<HTMLLIElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const locale = useLocale();
  const payer = memberName(members, ticket.payerUserId);
  const needsPerson = ticket.stage === "waiting_person";
  const canAct = needsPerson && canWrite;
  const canRetry = canAct && viewerId === ticket.payerUserId;
  const busy = retryTicket.isPending || closeTicket.isPending;

  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  const tone = STAGE_TONE[ticket.stage];

  return (
    <li
      ref={ref}
      data-ticket-id={ticket.id}
      className={cn(
        "flex min-w-0 gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/50",
        highlighted && "bg-muted",
      )}
    >
      <tone.Icon
        className={cn("mt-0.5 size-4 shrink-0", tone.icon)}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          href={`/dashboard/chat/${encodeURIComponent(ticket.workerThreadId)}`}
          className="line-clamp-2 break-words text-sm font-medium leading-snug hover:underline"
          title={t("tickets.openConversation")}
        >
          {ticket.title}
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className={tone.text}>
            {t(`tickets.stage.${ticket.stage}`)}
          </span>
          {payer ? (
            <span className="text-muted-foreground">
              {t("tickets.requestedBy", { name: payer })}
            </span>
          ) : null}
        </div>
        {ticket.blockedReason ? (
          <p className="text-xs text-destructive" role="status">
            {t(`tickets.blockedReason.${ticket.blockedReason}`)}
          </p>
        ) : null}
        {ticket.lastReportSummary ? (
          <p className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
            {ticket.lastReportSummary}
          </p>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("tickets.hideDetails") : t("tickets.showDetails")}
        </button>
        {expanded ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-muted/40 p-2 text-xs">
            <dt className="text-muted-foreground">
              {t("tickets.detail.goal")}
            </dt>
            <dd className="break-words">{ticket.goal}</dd>
            <dt className="text-muted-foreground">
              {t("tickets.detail.origin")}
            </dt>
            <dd>{t(`tickets.origin.${ticket.origin}`)}</dd>
            <dt className="text-muted-foreground">
              {t("tickets.detail.creditCap")}
            </dt>
            <dd className="tabular-nums">{ticket.creditCap}</dd>
            {ticket.consecutiveFailures > 0 ? (
              <>
                <dt className="text-muted-foreground">
                  {t("tickets.detail.failures")}
                </dt>
                <dd className="tabular-nums">{ticket.consecutiveFailures}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">
              {t("tickets.detail.created")}
            </dt>
            <dd>{new Date(ticket.createdAt).toLocaleString(locale)}</dd>
            {ticket.endedAt ? (
              <>
                <dt className="text-muted-foreground">
                  {t("tickets.detail.ended")}
                </dt>
                <dd>
                  {new Date(ticket.endedAt).toLocaleString(locale)}
                  {ticket.outcome
                    ? ` · ${t(`feed.event.${ticket.outcome}`)}`
                    : ""}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {canAct ? (
          <div className="flex gap-2 pt-1">
            {canRetry ? (
              <Button
                size="sm"
                className="max-md:h-10 max-md:px-4"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => retryTicket.mutateAsync(ticket.id),
                    t("toasts.retried"),
                  )
                }
              >
                {t("tickets.retry")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="max-md:h-10 max-md:px-4"
              disabled={busy}
              onClick={() =>
                void run(
                  () => closeTicket.mutateAsync(ticket.id),
                  t("toasts.closed"),
                )
              }
            >
              {t("tickets.close")}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
