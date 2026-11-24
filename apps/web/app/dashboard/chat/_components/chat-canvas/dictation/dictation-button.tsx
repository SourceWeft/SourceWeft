"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Mic } from "lucide-react";
import { useTranslations } from "next-intl";

import { PromptInputButton } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import { cn } from "@sourceweft/ui-web/lib/utils";

import type { DictationNotice } from "./dictation-session";
import type { UseDictation } from "./use-dictation";

// Each notice maps to a string key under composer.dictation; two of them reuse
// the generic "failed" line.
const NOTICE_KEY: Record<DictationNotice, string> = {
  "permission-denied": "permissionDenied",
  "no-device": "noDevice",
  unsupported: "failed",
  "insufficient-credits": "insufficientCredits",
  unavailable: "failed",
  "rate-limited": "rateLimited",
  failed: "failed",
  "silence-timeout": "silenceTimeout",
  "max-duration": "maxDuration",
  "device-lost": "deviceLost",
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Re-renders about twice a second while listening so the clock ticks. */
function useNowTick(listening: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!listening) {
      return;
    }
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [listening]);
  return nowMs;
}

export function ComposerDictationButton({
  dictation,
  disabled,
}: {
  dictation: UseDictation;
  disabled?: boolean;
}): ReactNode {
  const t = useTranslations("dashboardChatCanvas.composer.dictation");
  const { snapshot, visible, active, toggle } = dictation;
  const listening = snapshot.status === "listening";
  const nowMs = useNowTick(listening);

  if (!visible) {
    return null;
  }

  const pending =
    snapshot.status === "listening" || snapshot.status === "finishing"
      ? snapshot.pending
      : 0;
  const transcribing = snapshot.status === "finishing" || pending > 0;
  const notice = snapshot.status === "idle" ? snapshot.notice : null;

  const level =
    snapshot.status === "listening"
      ? Math.max(0, Math.min(1, (snapshot.levelDbfs + 60) / 60))
      : 0;
  const elapsed =
    snapshot.status === "listening"
      ? formatElapsed(nowMs - snapshot.startedAt)
      : null;

  const label = active ? t("stop") : t("start");

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <PromptInputButton
        aria-disabled={disabled || undefined}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "relative size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
          active &&
            "bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background",
          disabled && "pointer-events-none opacity-50",
        )}
        data-dictation-button="true"
        onClick={() => {
          if (!disabled) {
            toggle();
          }
        }}
        size="icon-sm"
        tooltip={label}
        type="button"
        variant="ghost"
      >
        {listening ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-background/70"
            style={{ transform: `scale(${(1 + level * 0.5).toFixed(3)})`, opacity: 0.35 + level * 0.5 }}
          />
        ) : null}
        <Mic className="size-4" />
        <span className="sr-only">{label}</span>
      </PromptInputButton>

      {elapsed ? (
        <span className="tabular-nums text-xs text-muted-foreground" aria-hidden="true">
          {elapsed}
        </span>
      ) : null}

      {transcribing ? (
        <span className="text-xs text-muted-foreground" role="status">
          {t("transcribing")}
        </span>
      ) : null}

      {notice ? (
        <span className="text-xs text-muted-foreground" role="status">
          {t(NOTICE_KEY[notice])}
        </span>
      ) : null}
    </div>
  );
}
