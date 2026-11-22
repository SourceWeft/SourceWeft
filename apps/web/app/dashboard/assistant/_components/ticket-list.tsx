"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type {
  AssistantTicket,
  TicketStage,
} from "@sourceweft/contracts/assistants";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
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

const STAGE_VARIANT = {
  queued: "outline",
  working: "default",
  waiting_person: "destructive",
  idle: "secondary",
  ended: "outline",
} as const satisfies Record<TicketStage, string>;

export function TicketList({
  workspaceId,
  tickets,
  members,
  canWrite,
  highlightTicketId = null,
}: {
  workspaceId: string | null;
  tickets: readonly AssistantTicket[];
  members: readonly WorkspaceMember[];
  /** Retry and Close are writes; a read-only member is not offered them. */
  canWrite: boolean;
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
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        {t("tickets.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.key} data-group={group.key} className="grid gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(`tickets.groups.${group.key}`)}
          </h3>
          <ul className="grid gap-2">
            {group.tickets.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                members={members}
                workspaceId={workspaceId}
                canWrite={canWrite}
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
  highlighted,
}: {
  ticket: AssistantTicket;
  members: readonly WorkspaceMember[];
  workspaceId: string | null;
  canWrite: boolean;
  highlighted: boolean;
}) {
  const t = useTranslations("dashboardAssistant");
  const { retryTicket, closeTicket } = useAssistantMutations(workspaceId);
  const { run } = useAssistantAction();
  const ref = React.useRef<HTMLLIElement>(null);
  const payer = memberName(members, ticket.payerUserId);
  const needsPerson = ticket.stage === "waiting_person";
  const canAct = needsPerson && canWrite;
  const busy = retryTicket.isPending || closeTicket.isPending;

  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  return (
    <li
      ref={ref}
      data-ticket-id={ticket.id}
      className={cn(
        "grid gap-1.5 rounded-xl border border-border bg-card p-3",
        highlighted && "ring-2 ring-primary",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/dashboard/chat/${encodeURIComponent(ticket.workerThreadId)}`}
          className="min-w-0 truncate font-medium hover:underline"
          title={t("tickets.openConversation")}
        >
          {ticket.title}
        </Link>
        <Badge variant={STAGE_VARIANT[ticket.stage]}>
          {t(`tickets.stage.${ticket.stage}`)}
        </Badge>
      </div>
      {payer ? (
        <p className="text-xs text-muted-foreground">
          {t("tickets.requestedBy", { name: payer })}
        </p>
      ) : null}
      {ticket.blockedReason ? (
        <p className="text-xs text-destructive" role="status">
          {t(`tickets.blockedReason.${ticket.blockedReason}`)}
        </p>
      ) : null}
      {ticket.lastReportSummary ? (
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {ticket.lastReportSummary}
        </p>
      ) : null}
      {canAct ? (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
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
          <Button
            size="sm"
            variant="outline"
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
