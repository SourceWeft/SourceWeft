"use client";

import * as React from "react";
import type {
  SkillSubmission,
  SkillSubmissionSkillResult,
} from "@sourceweft/contracts";
import {
  Check,
  ChevronRight,
  Circle,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { contentClient } from "../../../../lib/sdk";
import { SubmissionRateLimitNotice } from "./community/submission-rate-limit-notice";

/**
 * A community skill is imported by a background job; the submission row is its
 * progress and outcome record. Everything here reads that row: the hook keeps
 * the caller's submissions fresh while any is in flight, and the views render
 * one — in the submit dialog while it runs, and in "My submissions" afterwards.
 *
 * The polling lives with the skills page, not with the dialog, so closing the
 * dialog changes nothing: the import carries on server-side and its progress
 * stays visible in the list.
 */

const SUBMISSION_POLL_INTERVAL_MS = 2_000;
const SUBMISSIONS_PAGE_SIZE = 20;

type Translate = ReturnType<typeof useTranslations>;

// The pipeline's stages in execution order, so the ones that have not started
// can be listed ahead of time. A stage the server adds later still shows up —
// under its own name — once it starts. Each is worded by
// `dashboardSkillsMarket.submissions.stages.<name>`.
const KNOWN_STAGES: readonly string[] = [
  "resolve",
  "download",
  "discover",
  "analyze-scan",
  "triage-write",
  "on-complete",
];

export type SubmissionStageRow = {
  name: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
  error?: string;
};

export function isSubmissionInFlight(submission: SkillSubmission) {
  return submission.status === "queued" || submission.status === "running";
}

/**
 * Started stages as the server ordered them, then the known ones still ahead.
 * `t` is the `dashboardSkillsMarket` translator.
 */
export function submissionStageRows(
  submission: SkillSubmission,
  t: Translate,
): SubmissionStageRow[] {
  const label = (name: string) =>
    KNOWN_STAGES.includes(name) ? t(`submissions.stages.${name}`) : name;
  const rows: SubmissionStageRow[] = Object.entries(submission.stages).map(
    ([name, stage]) => ({
      name,
      label: label(name),
      status: stage.status,
      ...(stage.error ? { error: stage.error.message } : {}),
    }),
  );
  // Once the run is over, a stage that never started never will.
  if (!isSubmissionInFlight(submission)) {
    return rows;
  }
  const started = new Set(rows.map((row) => row.name));
  for (const name of KNOWN_STAGES) {
    if (started.has(name)) continue;
    // Only a submission that asked for an install runs that stage visibly.
    if (name === "on-complete" && !submission.onComplete?.install) {
      continue;
    }
    rows.push({ name, label: label(name), status: "pending" });
  }
  return rows;
}

export function summarizeSubmissionResults(
  results: SkillSubmissionSkillResult[],
) {
  const count = (status: SkillSubmissionSkillResult["status"]) =>
    results.filter((result) => result.status === status).length;
  return {
    indexed: count("indexed"),
    queued: count("queued"),
    failed: count("failed"),
  };
}

function upsert(items: SkillSubmission[], next: SkillSubmission) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    // Newest first, like the server's listing.
    return [next, ...items];
  }
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/**
 * The caller's submissions in one workspace, kept current while any of them is
 * queued or running. `onFinished` fires once per submission that reaches a
 * terminal state while being watched — the moment the catalog may have changed.
 */
export function useSkillSubmissions({
  workspaceId,
  onFinished,
}: {
  workspaceId: string | null;
  onFinished?: (submission: SkillSubmission) => void;
}) {
  const tm = useTranslations("dashboardSkillsMarket");
  const [items, setItems] = React.useState<SkillSubmission[]>([]);
  const onFinishedRef = React.useRef(onFinished);
  // Two polls of one submission can both come back terminal before the
  // interval is torn down; it still finished once.
  const announcedRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  React.useEffect(() => {
    setItems([]);
    if (!workspaceId) return;
    let active = true;
    contentClient
      .listSkillSubmissions(workspaceId, { limit: SUBMISSIONS_PAGE_SIZE })
      .then((result) => {
        // Anything tracked while the list was loading is newer than the list.
        if (active) {
          setItems((current) =>
            current.reduce(upsert, result.items.slice()).sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            ),
          );
        }
      })
      .catch(() => {
        // The list is a convenience; the catalog works without it.
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const inFlightKey = items
    .filter(isSubmissionInFlight)
    .map((item) => item.id)
    .join(",");
  React.useEffect(() => {
    if (!workspaceId || !inFlightKey) return;
    let active = true;
    const ids = inFlightKey.split(",");
    const timer = window.setInterval(() => {
      for (const id of ids) {
        contentClient
          .getSkillSubmission(workspaceId, id)
          .then(({ submission }) => {
            if (!active) return;
            setItems((current) => upsert(current, submission));
            // Keyed by attempt: a retried submission finishes again.
            const key = `${submission.id}:${submission.attempts}`;
            if (
              !isSubmissionInFlight(submission) &&
              !announcedRef.current.has(key)
            ) {
              announcedRef.current.add(key);
              onFinishedRef.current?.(submission);
            }
          })
          .catch(() => {
            // A missed poll is retried by the next tick.
          });
      }
    }, SUBMISSION_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, inFlightKey]);

  const track = React.useCallback((submission: SkillSubmission) => {
    setItems((current) => upsert(current, submission));
  }, []);

  const retry = React.useCallback(
    async (submissionId: string) => {
      if (!workspaceId) return;
      try {
        const { submission } = await contentClient.retrySkillSubmission(
          workspaceId,
          submissionId,
        );
        track(submission);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : tm("submissions.retryFailed"),
        );
      }
    },
    [tm, track, workspaceId],
  );

  return { items, track, retry };
}

export type SkillSubmissionsController = ReturnType<typeof useSkillSubmissions>;

export function SubmissionStatusBadge({
  submission,
}: {
  submission: SkillSubmission;
}) {
  const tm = useTranslations("dashboardSkillsMarket");
  const status = `submissions.status.${submission.status}`;
  return (
    <Badge
      className={cn(
        "h-5 shrink-0 gap-1 px-1.5 text-[10px]",
        submission.status === "failed" &&
          "border-destructive/30 text-destructive",
        submission.status === "succeeded" &&
          "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
      )}
      variant="outline"
    >
      {isSubmissionInFlight(submission) ? (
        <Loader2 className="size-3 animate-spin" />
      ) : null}
      {tm.has(status) ? tm(status) : submission.status}
    </Badge>
  );
}

function StageIcon({ status }: { status: SubmissionStageRow["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin" />;
  }
  if (status === "succeeded") {
    return <Check className="size-3.5 shrink-0 text-emerald-600" />;
  }
  if (status === "failed") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />;
}

export function SubmissionStages({
  submission,
}: {
  submission: SkillSubmission;
}) {
  const tm = useTranslations("dashboardSkillsMarket");
  const rows = submissionStageRows(submission, tm);
  // Only an import that never reached a worker (it could not be queued).
  if (rows.length === 0) return null;
  return (
    <ol aria-label={tm("submissions.progressLabel")} className="space-y-1.5 text-xs">
      {rows.map((row) => (
        <li
          className={cn(
            "flex items-start gap-2",
            row.status === "pending" && "text-muted-foreground",
          )}
          data-status={row.status}
          key={row.name}
        >
          <span className="mt-0.5">
            <StageIcon status={row.status} />
          </span>
          <span className="min-w-0">
            {row.label}
            {row.error ? (
              <span className="block text-destructive">{row.error}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function SubmissionResults({
  results,
}: {
  results: SkillSubmissionSkillResult[];
}) {
  const t = useTranslations("dashboardSkills");
  const tm = useTranslations("dashboardSkillsMarket");
  if (results.length === 0) return null;
  const summary = summarizeSubmissionResults(results);
  return (
    <section aria-label={t("submit.resultsAriaLabel")} className="space-y-3 text-sm">
      <p role="status">{t("submit.resultsSummary", summary)}</p>
      {results.map((result, index) => (
        <div
          className="rounded-md border p-3"
          key={`${result.sourcePath}-${index}`}
        >
          <p className="font-medium">
            {result.name ?? result.sourcePath ?? t("submit.skillFallback")} —{" "}
            {tm.has(`submissions.resultStatus.${result.status}`)
              ? tm(`submissions.resultStatus.${result.status}`)
              : result.status}
          </p>
          <p className="text-xs text-muted-foreground">
            {result.sourcePath || t("submit.repositoryRoot")}
            {result.version ? ` · ${result.version}` : ""}
          </p>
          {result.diagnostics.map((diagnostic, i) => (
            <p
              className={
                diagnostic.severity === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
              key={i}
            >
              {diagnostic.file}
              {diagnostic.line
                ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}`
                : ""}{" "}
              {diagnostic.message}
            </p>
          ))}
          {result.flags.length ? (
            <p>{t("submit.reviewFlags", { flags: result.flags.join(", ") })}</p>
          ) : null}
          {result.install?.status === "failed" ? (
            <p className="text-destructive">
              {tm("submissions.notInstalled", {
                reason:
                  result.install.error?.message ??
                  tm("submissions.notInstalledFallback"),
              })}
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** Progress while it runs; results and the error (with Retry) once it is over. */
export function SubmissionDetail({
  submission,
  onRetry,
}: {
  submission: SkillSubmission;
  onRetry: (submissionId: string) => Promise<void>;
}) {
  const t = useTranslations("dashboardSkills");
  const tm = useTranslations("dashboardSkillsMarket");
  const locale = useLocale();
  const [retrying, setRetrying] = React.useState(false);
  return (
    <div className="space-y-3">
      <SubmissionStages submission={submission} />
      <SubmissionRateLimitNotice locale={locale} submission={submission} />
      {submission.status === "failed" ? (
        <div className="space-y-2 text-sm" role="alert">
          <p className="text-destructive">
            {submission.error?.message ?? tm("submissions.failed")}
          </p>
          <Button
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void onRetry(submission.id).finally(() => setRetrying(false));
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {retrying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )}
            {t("actions.retry")}
          </Button>
        </div>
      ) : null}
      <SubmissionResults results={submission.results} />
    </div>
  );
}

function formatSubmittedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/** The caller's imports in this workspace, newest first; nothing when empty. */
export function MySubmissions({
  submissions,
}: {
  submissions: SkillSubmissionsController;
}) {
  const tm = useTranslations("dashboardSkillsMarket");
  const { items, retry } = submissions;
  const running = items.filter(isSubmissionInFlight).length;
  const [open, setOpen] = React.useState(false);
  // Opens itself when an import starts; after that it is the reader's to close.
  React.useEffect(() => {
    if (running > 0) setOpen(true);
  }, [running]);
  if (items.length === 0) return null;
  return (
    <details
      className="group mb-4 rounded-lg border border-border bg-background"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-accent/40">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {tm("submissions.title")}
        <span className="text-muted-foreground">
          {items.length}
          {running > 0
            ? ` · ${tm("submissions.inProgress", { count: running })}`
            : ""}
        </span>
      </summary>
      <ul className="divide-y divide-border border-t border-border">
        {items.map((submission) => (
          <li key={submission.id}>
            <details className="group/item">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-accent/40">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/item:rotate-90" />
                <SubmissionStatusBadge submission={submission} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {submission.sourceInput}
                </span>
                <time
                  className="shrink-0 text-muted-foreground"
                  dateTime={submission.createdAt}
                >
                  {formatSubmittedAt(submission.createdAt)}
                </time>
              </summary>
              <div className="px-3 pb-3 pl-8">
                <SubmissionDetail onRetry={retry} submission={submission} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}
