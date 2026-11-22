"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { ASSISTANT_LIMITS } from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import {
  assistantErrorCode,
  useAssistantMutations,
} from "../../../../lib/assistant";
import { useAssistantAction } from "./use-assistant-actions";

/**
 * Writes one message to the assistant's shared feed.
 *
 * Each send gets its own idempotency key, minted for the text being sent.
 * A send that fails keeps the draft and its key, so sending the same draft
 * again is the same send (the server replays it instead of posting twice
 * when the first attempt did land). Editing the draft makes it a new send
 * with a new key.
 */
export function FeedComposer({
  workspaceId,
  disabledReason = null,
}: {
  workspaceId: string | null;
  /** Why this viewer cannot send right now (a paused assistant, say). */
  disabledReason?: string | null;
}) {
  const t = useTranslations("dashboardAssistant");
  const { postMessage } = useAssistantMutations(workspaceId);
  const { describe } = useAssistantAction();
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [shortcut, setShortcut] = React.useState("Ctrl+Enter");
  const pending = React.useRef<{ text: string; key: string } | null>(null);

  React.useEffect(() => {
    // Only known in the browser; the server render keeps the default.
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcut("⌘+Enter");
  }, []);

  const text = draft.trim();
  const tooLong = text.length > ASSISTANT_LIMITS.feedMessageMax;
  const disabled = Boolean(disabledReason) || !workspaceId;
  const canSend = !disabled && !sending && text.length > 0 && !tooLong;

  async function send() {
    if (!canSend) return;
    if (pending.current?.text !== text) {
      pending.current = { text, key: crypto.randomUUID() };
    }
    const { key } = pending.current;
    setSending(true);
    try {
      await postMessage.mutateAsync({ text, idempotencyKey: key });
      pending.current = null;
      setDraft("");
    } catch (error) {
      // The draft and its key stay, so a retry is the same send.
      toast.error(
        assistantErrorCode(error) ? describe(error) : t("composer.sendFailed"),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {disabledReason ? (
        <p className="text-sm text-muted-foreground" role="status">
          {disabledReason}
        </p>
      ) : null}
      <Textarea
        aria-label={t("composer.label")}
        className="min-h-20 resize-y"
        disabled={disabled}
        placeholder={t("composer.placeholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <p
          className={
            tooLong
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
          role={tooLong ? "alert" : undefined}
        >
          {tooLong
            ? t("composer.tooLong", { max: ASSISTANT_LIMITS.feedMessageMax })
            : disabled
              ? null
              : t("composer.hint", { shortcut })}
        </p>
        <Button type="submit" size="sm" disabled={!canSend}>
          <SendHorizontal className="size-4" aria-hidden />
          {sending ? t("composer.sending") : t("composer.send")}
        </Button>
      </div>
    </form>
  );
}
