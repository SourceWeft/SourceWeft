"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { SourceGuide } from "@sourceweft/contracts/sources";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../lib/sdk";

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 40;

type Phase = "loading" | "ready" | "error";

/**
 * The guide of one source: summary, main topics and suggested questions. A
 * guide that is waiting, failed or out of date says why and offers the one
 * action that moves it forward; generating it is charged to whoever asks.
 */
export function SourceGuideCard({
  sourceId,
  workspaceId,
}: {
  sourceId: string;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [guide, setGuide] = useState<SourceGuide | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [expanded, setExpanded] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [pollCount, setPollCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setGuide(null);
    setPollCount(0);
    contentClient
      .getSourceGuide(workspaceId, sourceId)
      .then((result) => {
        if (cancelled) return;
        setGuide(result.guide);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, workspaceId]);

  // Waiting on the worker: poll until it finishes, then stop.
  const inFlight =
    guide !== null &&
    (guide.status === "generating" ||
      (guide.status === "pending" && guide.errorCode === null));
  useEffect(() => {
    if (!inFlight || pollCount >= MAX_POLLS) return;
    const timer = window.setTimeout(() => {
      contentClient
        .getSourceGuide(workspaceId, sourceId)
        .then((result) => setGuide(result.guide))
        .catch(() => undefined)
        .finally(() => setPollCount((count) => count + 1));
    }, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight, pollCount, sourceId, workspaceId]);

  const request = useCallback(async () => {
    setRequesting(true);
    try {
      const result = await contentClient.requestSourceGuide(
        workspaceId,
        sourceId,
      );
      setGuide(result.guide);
      setPollCount(0);
    } catch {
      toast.error(t("sourceGuide.requestFailed"));
    } finally {
      setRequesting(false);
    }
  }, [sourceId, t, workspaceId]);

  const copyQuestion = async (question: string) => {
    try {
      await navigator.clipboard.writeText(question);
      toast.success(t("sourceGuide.questionCopied"));
    } catch {
      toast.error(t("sourceGuide.questionCopyFailed"));
    }
  };

  if (phase === "loading") return null;
  if (phase === "error") return null;

  const action = (label: string) => (
    <Button
      className="shrink-0"
      disabled={requesting}
      onClick={() => void request()}
      size="xs"
      type="button"
      variant="outline"
    >
      {requesting ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {label}
    </Button>
  );

  let status: { text: string; action?: string } | null = null;
  if (!guide) {
    status = { text: t("sourceGuide.none"), action: t("sourceGuide.generate") };
  } else if (guide.status === "failed") {
    status =
      guide.errorCode === "EMPTY_SOURCE"
        ? { text: t("sourceGuide.emptySource") }
        : {
            text: t("sourceGuide.failed"),
            action: t("sourceGuide.retry"),
          };
  } else if (guide.status === "pending" && guide.errorCode === "QUOTA") {
    status = { text: t("sourceGuide.quota"), action: t("sourceGuide.retry") };
  } else if (guide.status === "pending" && guide.errorCode === "NO_PAYER") {
    status = {
      text: t("sourceGuide.noPayer"),
      action: t("sourceGuide.generate"),
    };
  } else if (inFlight && !guide.content) {
    status = { text: t("sourceGuide.generating") };
  }

  return (
    <section
      className="shrink-0 border-b bg-muted/15 px-5 py-3 lg:px-8"
      data-source-guide
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="size-4 text-primary" />
          {t("sourceGuide.title")}
          {inFlight && guide?.content ? (
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("sourceGuide.updating")}
            </span>
          ) : null}
        </div>
        {guide?.content ? (
          <Button
            aria-label={
              expanded ? t("sourceGuide.collapse") : t("sourceGuide.expand")
            }
            onClick={() => setExpanded((value) => !value)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </Button>
        ) : null}
      </div>

      {status ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            {guide && inFlight ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            {status.text}
          </span>
          {status.action ? action(status.action) : null}
        </div>
      ) : null}

      {guide?.content && expanded ? (
        <div className="mt-2 max-h-[45vh] space-y-3 overflow-auto pr-1">
          <p className="text-sm leading-6 text-foreground">
            {guide.content.summary}
          </p>
          {guide.content.topics.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {t("sourceGuide.topics")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {guide.content.topics.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {t("sourceGuide.questions")}
            </div>
            <ul className="space-y-1">
              {guide.content.suggestedQuestions.map((question) => (
                <li key={question}>
                  <button
                    className="group flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-sm text-foreground hover:bg-muted/60"
                    onClick={() => void copyQuestion(question)}
                    title={t("sourceGuide.copyQuestion")}
                    type="button"
                  >
                    <span className="flex-1">{question}</span>
                    <Copy className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {guide.stale ? (
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{t("sourceGuide.stale")}</span>
              {action(t("sourceGuide.regenerate"))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
