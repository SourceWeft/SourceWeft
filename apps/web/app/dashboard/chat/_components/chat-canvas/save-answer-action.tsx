"use client";

import { useState } from "react";
import { BookmarkCheck, BookmarkPlus, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MessageAction } from "@sourceweft/ui-web/components/ai-elements/message";
import { HttpClientError } from "@sourceweft/sdk";
import { contentClient } from "../../../../../lib/sdk";

type SaveState = "idle" | "saving" | "saved";

/** Saves one assistant answer, with its citations, as a searchable note. */
export function SaveAnswerAction({
  messageId,
  workspaceId,
}: {
  messageId: string;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const [state, setState] = useState<SaveState>("idle");

  const save = async () => {
    if (state !== "idle") return;
    setState("saving");
    try {
      const result = await contentClient.saveAnswerAsNote(
        workspaceId,
        messageId,
      );
      setState("saved");
      toast.success(
        result.alreadySaved
          ? t("messageList.noteAlreadySaved")
          : t("messageList.noteSaved", { title: result.title }),
      );
    } catch (error) {
      setState("idle");
      toast.error(
        error instanceof HttpClientError && error.status === 402
          ? t("messageList.noteSaveQuota")
          : t("messageList.noteSaveFailed"),
      );
    }
  };

  const label =
    state === "saved"
      ? t("messageList.noteSavedLabel")
      : t("messageList.saveAsNote");
  return (
    <MessageAction
      className="text-muted-foreground hover:text-foreground"
      disabled={state === "saving"}
      label={label}
      onClick={() => void save()}
      size="icon-sm"
      tooltip={label}
      type="button"
      variant="ghost"
    >
      {state === "saving" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : state === "saved" ? (
        <BookmarkCheck className="size-3" />
      ) : (
        <BookmarkPlus className="size-3" />
      )}
    </MessageAction>
  );
}
