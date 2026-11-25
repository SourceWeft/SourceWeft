"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { ASSISTANT_LIMITS } from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
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
  seed = null,
}: {
  workspaceId: string | null;
  /**
   * Text to put in the box, such as a suggestion the reader picked. Each new
   * `id` replaces the draft and moves focus to the box.
   */
  seed?: { id: number; text: string } | null;
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
  const field = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    // Only known in the browser; the server render keeps the default.
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcut("⌘+Enter");
  }, []);

  React.useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    field.current?.focus();
  }, [seed]);

  React.useLayoutEffect(() => {
    // Grows with the draft up to a cap, then scrolls inside.
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draft]);

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
      // Clear only what was sent: anything typed while the send was in
      // flight stays, as the next message.
      setDraft((current) => (current.trim() === text ? "" : current));
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
      className="flex flex-col gap-1.5 pt-2 pb-3 md:pb-6"
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
      <div
        className={cn(
          "flex items-end gap-2 rounded-2xl border border-border bg-card py-1.5 pr-1.5 pl-3.5 transition-colors focus-within:border-ring/60",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={field}
          rows={1}
          aria-label={t("composer.label")}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-snug outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
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
        <Button
          type="submit"
          size="icon"
          className="size-9 shrink-0 rounded-xl"
          disabled={!canSend}
        >
          <SendHorizontal className="size-4" aria-hidden />
          <span className="sr-only">
            {sending ? t("composer.sending") : t("composer.send")}
          </span>
        </Button>
      </div>
      {tooLong || (!disabled && shortcut) ? (
        <p
          className={cn(
            "px-1 text-xs",
            tooLong
              ? "text-destructive"
              : "text-muted-foreground max-md:hidden",
          )}
          role={tooLong ? "alert" : undefined}
        >
          {tooLong
            ? t("composer.tooLong", { max: ASSISTANT_LIMITS.feedMessageMax })
            : t("composer.hint", { shortcut })}
        </p>
      ) : null}
    </form>
  );
}
