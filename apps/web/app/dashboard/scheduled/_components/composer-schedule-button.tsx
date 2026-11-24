"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import {
  PromptInputButton,
  usePromptInputController,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import { TaskFormDialog } from "./task-form-dialog";

/**
 * The composer holds source and command markers (`[source:id](Title)`); a task
 * stores plain text, so a source becomes `@Title` and a command disappears.
 */
export function composerTextToPrompt(value: string) {
  return value
    .replace(/\[source:[^\]]*\]\(((?:\\.|[^)\\])*)\)/g, "@$1")
    .replace(/\[(?:skills|tool):[^\]]*\]\((?:\\.|[^)\\])*\)/g, "")
    .replace(/\\([\\\])])/g, "$1")
    .trim();
}

/** Opens the new-task form with what is typed in the composer as its prompt. */
export function ComposerScheduleButton({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const t = useTranslations("dashboardScheduled");
  const { textInput } = usePromptInputController();
  const [open, setOpen] = React.useState(false);
  const [seed, setSeed] = React.useState("");

  return (
    <>
      <PromptInputButton
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        disabled={!workspaceId}
        tooltip={t("composer.schedule")}
        onClick={() => {
          setSeed(composerTextToPrompt(textInput.value));
          setOpen(true);
        }}
      >
        <CalendarClock className="size-3.5" />
        <span className="sr-only">{t("composer.schedule")}</span>
      </PromptInputButton>
      {/* Mounted on demand: the form reads the query cache, the composer need not. */}
      {open ? (
        <TaskFormDialog
          open
          onOpenChange={setOpen}
          workspaceId={workspaceId}
          seedPrompt={seed}
        />
      ) : null}
    </>
  );
}
