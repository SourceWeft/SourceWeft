"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
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

/** A stage's dot and label colour; the dot carries the state, the label names it. */
const STAGE_TONE = {
  queued: { dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  working: { dot: "bg-primary", text: "text-foreground" },
  waiting_person: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  idle: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
  ended: { dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
} as const satisfies Record<TicketStage, { dot: string; text: string }>;

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
    <div className="flex min-w-0 flex-col gap-6">
      {groups.map((group) => (
        <section
          key={group.key}
          data-group={group.key}
          className="flex min-w-0 flex-col gap-1"
        >
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {t(`tickets.groups.${group.key}`)}
            <span className="tabular-nums text-muted-foreground/70">
              {group.tickets.length}
            </span>
          </h3>
          <ul className="flex min-w-0 flex-col divide-y divide-border/60">
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
        </section>
      ))}
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
        "flex min-w-0 flex-col gap-1.5 py-3 first:pt-2",
        highlighted && "-mx-2 rounded-lg bg-muted/60 px-2",
      )}
    >
      <Link
        href={`/dashboard/chat/${encodeURIComponent(ticket.workerThreadId)}`}
        className="line-clamp-2 break-words text-sm font-medium leading-snug hover:underline"
        title={t("tickets.openConversation")}
      >
        {ticket.title}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className={cn("inline-flex items-center gap-1.5", tone.text)}>
          <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
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
    </li>
  );
}
