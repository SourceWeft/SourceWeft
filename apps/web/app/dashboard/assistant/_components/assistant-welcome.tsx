"use client";

import { useTranslations } from "next-intl";
import { MessageSquarePlus, ScrollText, Ticket } from "lucide-react";

const SUGGESTIONS = ["changes", "questions", "briefing", "outdated"] as const;
const STEPS = [
  { key: "ask", Icon: MessageSquarePlus },
  { key: "ticket", Icon: Ticket },
  { key: "report", Icon: ScrollText },
] as const;

/**
 * What a workspace sees before anyone has asked the assistant for anything:
 * a greeting, a few requests to start from, and how the work flows. A pick
 * only fills the message box; nothing is sent until the reader sends it.
 */
export function AssistantWelcome({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  const t = useTranslations("dashboardAssistant");
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 py-6 text-center">
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
        {t("welcome.title")}
      </h2>
      <div className="flex max-w-2xl flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => onPick(t(`welcome.suggestions.${key}`))}
          >
            {t(`welcome.suggestions.${key}`)}
          </button>
        ))}
      </div>
      <ol className="grid w-full max-w-3xl gap-4 text-left max-md:hidden md:grid-cols-3">
        {STEPS.map(({ key, Icon }) => (
          <li key={key} className="flex gap-3">
            <Icon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t(`welcome.steps.${key}.title`)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(`welcome.steps.${key}.body`)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
