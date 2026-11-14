"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  PanelRightClose,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { SourceGuide } from "@sourceweft/contracts/sources";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../lib/sdk";
import { BREAKPOINTS, useMediaQuery } from "../../../../lib/use-media-query";

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 40;
const RAIL_PREFERENCE_KEY = "sourceweft:source-guide-expanded";

type Phase = "loading" | "ready" | "error";

/**
 * The guide of one source: summary, main topics and suggested questions. A
 * guide that is waiting, failed or out of date says why and offers the one
 * action that moves it forward; generating it is charged to whoever asks.
 *
 * On a wide screen the guide is a rail beside the source, open unless the
 * reader closed it; that choice is remembered. On a narrow screen, and in a
 * view that needs the width (`collapsedByDefault`), it starts as one line and
 * opens on request without changing the remembered choice.
 */
export function SourceGuideCard({
  sourceId,
  workspaceId,
  collapsedByDefault = false,
}: {
  sourceId: string;
  workspaceId: string;
  collapsedByDefault?: boolean;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const router = useRouter();
  const [guide, setGuide] = useState<SourceGuide | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const isWide = useMediaQuery(BREAKPOINTS.lg);
  const [railPreference, setRailPreference] = useState(true);
  const [openedHere, setOpenedHere] = useState(false);
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

  useEffect(() => {
    try {
      setRailPreference(localStorage.getItem(RAIL_PREFERENCE_KEY) !== "false");
    } catch {
      /* Storage can be unavailable in a private WebView. */
    }
  }, []);

  const followsPreference = isWide && !collapsedByDefault;
  const expanded = followsPreference ? railPreference : openedHere;
  const toggle = () => {
    if (!followsPreference) {
      setOpenedHere((value) => !value);
      return;
    }
    const next = !railPreference;
    setRailPreference(next);
    try {
      localStorage.setItem(RAIL_PREFERENCE_KEY, String(next));
    } catch {
      /* Keep the in-memory preference. */
    }
  };

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

  // Opens a new chat with this source selected and the question ready to send.
  const askQuestion = (question: string) => {
    const params = new URLSearchParams({ ask: question, ask_source: sourceId });
    router.push(`/dashboard/chat?${params.toString()}`);
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

  const toggleLabel = expanded
    ? t("sourceGuide.collapse")
    : t("sourceGuide.expand");

  if (isWide && !expanded) {
    return (
      <section
        aria-label={t("sourceGuide.title")}
        className="flex shrink-0 justify-center border-l bg-muted/15 py-3 lg:order-last lg:w-11"
        data-source-guide
        data-state="collapsed"
      >
        <Button
          aria-label={toggleLabel}
          onClick={toggle}
          size="icon-sm"
          title={toggleLabel}
          type="button"
          variant="ghost"
        >
          <Sparkles className="size-4 text-primary" />
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label={t("sourceGuide.title")}
      className="flex shrink-0 flex-col border-b bg-muted/15 px-5 py-3 lg:order-last lg:w-80 lg:border-b-0 lg:border-l lg:px-4"
      data-source-guide
      data-state={expanded ? "expanded" : "collapsed"}
    >
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="size-4 text-primary" />
          {t("sourceGuide.title")}
          {inFlight && guide?.content ? (
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("sourceGuide.updating")}
            </span>
          ) : null}
        </div>
        {guide?.content && !expanded ? (
          <button
            className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground hover:text-foreground"
            data-source-guide-preview
            onClick={toggle}
            title={toggleLabel}
            type="button"
          >
            {guide.content.summary}
          </button>
        ) : (
          <span className="flex-1" />
        )}
        {isWide || guide?.content ? (
          <Button
            aria-expanded={expanded}
            aria-label={toggleLabel}
            className="shrink-0"
            onClick={toggle}
            size="icon-xs"
            title={toggleLabel}
            type="button"
            variant="ghost"
          >
            {isWide ? (
              <PanelRightClose className="size-4" />
            ) : expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </Button>
        ) : null}
      </div>

      {status ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-muted-foreground">
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
        <div className="mt-2 max-h-[40vh] space-y-3 overflow-y-auto pr-1 lg:max-h-none lg:min-h-0 lg:flex-1">
          <p className="text-sm leading-6 text-foreground lg:text-[13px] lg:leading-5">
            {guide.content.summary}
          </p>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {t("sourceGuide.questions")}
            </div>
            <ul className="space-y-1">
              {guide.content.suggestedQuestions.map((question) => (
                <li className="group flex items-start gap-1" key={question}>
                  <button
                    className="-ml-2 flex-1 rounded-lg px-2 py-1 text-left text-sm text-foreground hover:bg-muted/60"
                    onClick={() => askQuestion(question)}
                    title={t("sourceGuide.askQuestion")}
                    type="button"
                  >
                    {question}
                  </button>
                  <Button
                    aria-label={t("sourceGuide.copyQuestion")}
                    className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => void copyQuestion(question)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
          {guide.content.topics.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {t("sourceGuide.topics")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {guide.content.topics.map((topic) => (
                  <Badge
                    className="h-auto max-w-full justify-start text-left whitespace-normal"
                    key={topic}
                    variant="secondary"
                  >
                    {topic}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
          {guide.stale ? (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-muted-foreground">
              <span>{t("sourceGuide.stale")}</span>
              {action(t("sourceGuide.regenerate"))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
