"use client";

import { useTranslations } from "next-intl";
import { CircleAlert, PauseCircle } from "lucide-react";
import type {
  Assistant,
  AssistantTicket,
} from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useAssistantMutations } from "../../../../lib/assistant";
import { useAssistantAction } from "./use-assistant-actions";

/**
 * What needs a person, said once at the top of the page and only while
 * something does. Each count is the length of the list it opens, so the
 * strip never disagrees with the tickets beside it. Healthy and idle, it
 * renders nothing.
 */
export function AssistantSummary({
  assistant,
  workspaceId,
  canWrite,
  tickets,
  onShowTickets,
}: {
  assistant: Assistant;
  workspaceId: string | null;
  canWrite: boolean;
  tickets: readonly AssistantTicket[];
  onShowTickets: () => void;
}) {
  const t = useTranslations("dashboardAssistant");
  const { update } = useAssistantMutations(workspaceId);
  const { run } = useAssistantAction();
  const open = tickets.filter((ticket) => ticket.stage !== "ended");
  const waiting = open.filter(
    (ticket) => ticket.stage === "waiting_person",
  ).length;
  // A waiting ticket with a reason is counted once, as waiting.
  const blocked = open.filter(
    (ticket) => ticket.stage !== "waiting_person" && ticket.blockedReason,
  ).length;
  const paused = assistant.status === "paused";

  if (!paused && waiting === 0 && blocked === 0) return null;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm"
      role="status"
    >
      {paused ? (
        <span className="inline-flex items-center gap-2">
          <PauseCircle className="size-4 text-amber-500" aria-hidden />
          {assistant.statusReason
            ? t(`statusReason.${assistant.statusReason}`)
            : t("summary.paused")}
          {canWrite && assistant.statusReason !== "steward_left" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() =>
                void run(
                  () =>
                    update.mutateAsync({
                      version: assistant.version,
                      action: "resume",
                    }),
                  t("toasts.resumed"),
                )
              }
            >
              {t("menu.resume")}
            </Button>
          ) : null}
        </span>
      ) : null}
      {waiting > 0 ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 text-amber-700 hover:underline dark:text-amber-400"
          onClick={onShowTickets}
        >
          <CircleAlert className="size-4" aria-hidden />
          {t("summary.waiting", { count: waiting })}
        </button>
      ) : null}
      {blocked > 0 ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 text-destructive hover:underline"
          onClick={onShowTickets}
        >
          <CircleAlert className="size-4" aria-hidden />
          {t("summary.blocked", { count: blocked })}
        </button>
      ) : null}
    </div>
  );
}
