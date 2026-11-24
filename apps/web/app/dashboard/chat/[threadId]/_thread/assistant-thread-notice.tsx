"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ConciergeBell } from "lucide-react";
import type { ChatItem } from "../../../_components/dashboard-chat-types";

/**
 * Stands where the composer would be in a workspace assistant's own
 * conversation: it does not take a member's messages (the server refuses
 * them), so the page says so and points to the assistant's page, where
 * members talk to it.
 */
export function AssistantThreadNotice({
  origin,
}: {
  origin: ChatItem["origin"];
}) {
  const t = useTranslations("dashboardAssistant.threadNotice");
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      <ConciergeBell className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {origin === "assistant_router" ? t("router") : t("ticket")}{" "}
        <Link
          href="/dashboard/assistant"
          className="font-medium text-foreground underline underline-offset-2"
        >
          {t("open")}
        </Link>
      </p>
    </div>
  );
}
