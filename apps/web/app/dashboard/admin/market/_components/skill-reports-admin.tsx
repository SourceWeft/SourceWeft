"use client";

import * as React from "react";
import Link from "next/link";
import { Flag, Loader2, MessageSquare } from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import {
  listSkillReports,
  resolveSkillReport,
  type SkillReportAction,
  type SkillReportItem,
  type SkillReportStatus,
} from "../../../../../lib/skill-reports";
import { skillReportCopy } from "../../../skills/_components/community/skill-report-copy";

const copy = skillReportCopy.admin;
const STATUSES: SkillReportStatus[] = ["open", "actioned", "dismissed"];
const PAGE_SIZE = 25;

/** Actions that change the market and are asked about twice. */
const DESTRUCTIVE: ReadonlySet<SkillReportAction> = new Set([
  "withdraw_skill",
  "revoke_version",
  "hide_review",
]);

/** The actions offered on a report; hiding a review only for a review report. */
export function reportActions(report: SkillReportItem): SkillReportAction[] {
  return [
    "dismiss",
    "none",
    "withdraw_skill",
    "revoke_version",
    ...(report.review ? (["hide_review"] as const) : []),
  ];
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ReportCard({
  report,
  onResolved,
}: {
  report: SkillReportItem;
  onResolved: (count: number) => void;
}) {
  const [resolution, setResolution] = React.useState("");
  const [alsoSameTarget, setAlsoSameTarget] = React.useState(false);
  const [confirming, setConfirming] = React.useState<SkillReportAction | null>(
    null,
  );
  const [busy, setBusy] = React.useState<SkillReportAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const open = report.status === "open";

  async function resolve(action: SkillReportAction) {
    if (DESTRUCTIVE.has(action) && confirming !== action) {
      setConfirming(action);
      return;
    }
    setConfirming(null);
    setBusy(action);
    setError(null);
    try {
      const result = await resolveSkillReport(report.id, {
        action,
        resolution,
        alsoResolveSameTarget: alsoSameTarget,
      });
      onResolved(result.resolvedReportIds.length);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? `${copy.resolveError} ${failure.message}`
          : copy.resolveError,
      );
    } finally {
      setBusy(null);
    }
  }

  const reporter = report.reporter;
  return (
    <li
      className="space-y-3 rounded-lg border p-4"
      data-testid="skill-report-item"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/dashboard/skills/${encodeURIComponent(report.skill.slug)}`}
          className="font-medium hover:underline"
        >
          {report.skill.displayName}
        </Link>
        <span className="text-xs text-muted-foreground">
          {report.skill.slug}
        </span>
        <Badge variant="outline">
          {copy.visibility[report.skill.visibility] ?? report.skill.visibility}
        </Badge>
        {report.skill.listingHold ? (
          <Badge variant="outline">{copy.held}</Badge>
        ) : null}
        <Badge variant="secondary">
          <Flag className="size-3" aria-hidden />
          {skillReportCopy.reasons[report.reason]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {formatDate(report.createdAt)}
        </span>
      </div>

      <p className="whitespace-pre-wrap text-sm">
        {report.details || (
          <span className="text-muted-foreground">{copy.noDetails}</span>
        )}
      </p>

      {report.review ? (
        <div
          className="rounded-md bg-muted/50 p-3 text-sm"
          data-testid="skill-report-review"
        >
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MessageSquare className="size-3" aria-hidden />
            {copy.aboutReview} · {"★".repeat(report.review.rating)}
            {report.review.status === "hidden"
              ? ` · ${copy.reviewHidden}`
              : null}
          </p>
          <p className="whitespace-pre-wrap">{report.review.excerpt}</p>
        </div>
      ) : null}

      <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt>{copy.reportedBy}</dt>
        <dd className="text-foreground">
          {reporter.userId ? reporter.displayName : copy.anonymous}
        </dd>
        {reporter.contactEmail ? (
          <>
            <dt>{copy.contact}</dt>
            <dd>
              <a
                className="text-foreground hover:underline"
                href={`mailto:${reporter.contactEmail}`}
              >
                {reporter.contactEmail}
              </a>
            </dd>
          </>
        ) : null}
        {reporter.accountEmail ? (
          <>
            <dt>{copy.account}</dt>
            <dd className="text-foreground">{reporter.accountEmail}</dd>
          </>
        ) : null}
        {!open && report.resolution ? (
          <>
            <dt>{copy.resolution}</dt>
            <dd className="text-foreground">{report.resolution}</dd>
          </>
        ) : null}
        {!open && report.resolvedBy ? (
          <>
            <dt>{copy.resolvedBy}</dt>
            <dd>
              {report.resolvedBy} · {formatDate(report.resolvedAt)}
            </dd>
          </>
        ) : null}
      </dl>

      {report.otherOpenReports > 0 ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {copy.otherOpen(report.otherOpenReports)}
        </p>
      ) : null}

      {open ? (
        <div className="space-y-2 border-t pt-3">
          <Textarea
            aria-label={copy.resolutionLabel}
            placeholder={copy.resolutionPlaceholder}
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            rows={2}
            maxLength={1000}
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={alsoSameTarget}
              onChange={(event) => setAlsoSameTarget(event.target.checked)}
            />
            {copy.alsoResolve}
          </label>
          {confirming ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2 text-sm"
              role="alertdialog"
            >
              <span className="flex-1">{copy.confirm[confirming]}</span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => resolve(confirming)}
              >
                {copy.confirmAction}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(null)}
              >
                {copy.cancel}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {reportActions(report).map((action) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={DESTRUCTIVE.has(action) ? "outline" : "secondary"}
                disabled={busy !== null}
                onClick={() => resolve(action)}
              >
                {busy === action ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : null}
                {copy.actions[action]}
              </Button>
            ))}
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Reports about community skills and their reviews (§17.2). */
export function SkillReportsAdmin() {
  const [status, setStatus] = React.useState<SkillReportStatus>("open");
  const [items, setItems] = React.useState<SkillReportItem[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const requestId = React.useRef(0);

  const load = React.useCallback(async (which: SkillReportStatus) => {
    const current = ++requestId.current;
    setLoading(true);
    setError(false);
    try {
      const page = await listSkillReports({ status: which, limit: PAGE_SIZE });
      if (current !== requestId.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch {
      if (current !== requestId.current) return;
      setItems([]);
      setNextCursor(null);
      setError(true);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(status);
  }, [load, status]);

  async function loadMore() {
    if (!nextCursor) return;
    const current = requestId.current;
    setLoadingMore(true);
    try {
      const page = await listSkillReports({
        status,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (current !== requestId.current) return;
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [
          ...previous,
          ...page.items.filter((item) => !seen.has(item.id)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (current === requestId.current) setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={copy.statusFilterLabel}
      >
        {STATUSES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={status === value ? "default" : "outline"}
            aria-pressed={status === value}
            onClick={() => {
              setNotice(null);
              setStatus(value);
            }}
          >
            {copy.statuses[value]}
          </Button>
        ))}
      </div>

      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {copy.loading}
        </p>
      ) : error && items.length === 0 ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-destructive">{copy.loadError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void load(status)}
          >
            {copy.retry}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.empty[status]}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              onResolved={(count) => {
                setNotice(copy.resolved(count));
                void load(status);
              }}
            />
          ))}
        </ul>
      )}

      {!loading && nextCursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          {copy.loadMore}
        </Button>
      ) : null}
    </section>
  );
}
