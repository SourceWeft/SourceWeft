"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Scale,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  acknowledgeSkillVersion,
  delistSkill,
  getSkillReviewVersion,
  listSkillListingQueue,
  listSkillPublicly,
  listSkillReviewQueue,
  publishSkillSubmission,
  rejectSkillSubmission,
  type SkillListingQueueEntry,
} from "../../../../../lib/skill-market-admin";
import {
  isCriticalSkillFlag,
  skillFlagLabel,
} from "../../../skills/_components/skills-market-browse";

type QueueItem = SkillListingQueueEntry;

/**
 * A public skill whose new version added scan flags or scripts. It is public
 * already, so "yes" keeps it public (acknowledges this version) and "no"
 * withdraws it; the other listing-queue entries are not public yet.
 */
function isPublicUpdate(item: QueueItem) {
  return (
    item.reason === "new-version-flags" || item.reason === "new-version-scripts"
  );
}

/**
 * The two admin queues look and behave alike — a flagged skill, its SKILL.md to
 * read, and a yes/no — and differ in what the answer does:
 * - `review`: a flagged DRAFT version. Approve publishes it, reject deprecates.
 * - `listing`: a PUBLISHED skill with an advisory flag. Yes lists it publicly,
 *   no keeps it private and holds it. For a skill that is public already and
 *   whose new version brought the flag or a script, yes keeps it public and
 *   no withdraws it. There is no reason to record.
 */
const QUEUES = {
  review: {
    // Where the queue's own wording lives in `dashboardSkillsMarket`; the
    // listing queue shares the rest of the review queue's.
    section: "review",
    takesReason: true,
    load: listSkillReviewQueue,
    approve: (item: QueueItem, reason?: string) =>
      publishSkillSubmission(item.skillVersionId, reason),
    decline: (item: QueueItem, reason?: string) =>
      rejectSkillSubmission(item.skillVersionId, reason),
  },
  listing: {
    section: "listingQueue",
    takesReason: false,
    load: listSkillListingQueue,
    approve: (item: QueueItem) =>
      isPublicUpdate(item)
        ? acknowledgeSkillVersion(item.skillVersionId)
        : listSkillPublicly(item.skillId),
    decline: (item: QueueItem) => delistSkill(item.skillId),
  },
} as const;

/** `t` is the `dashboardAdmin` translator, whose wording the MCP queue shares. */
function relativeTime(iso: string, t: ReturnType<typeof useTranslations>) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t("relativeTime.justNow");
  if (mins < 60) return t("relativeTime.minutes", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("relativeTime.hours", { count: hours });
  return t("relativeTime.days", { count: Math.round(hours / 24) });
}

type SkillMdState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; content: string | null };

/**
 * The skill market's flagged review queue: draft versions the automated scan
 * would not publish on its own. A reviewer reads the flags and the SKILL.md,
 * then publishes or rejects, optionally recording why.
 */
export function SkillReviewQueue({
  queue = "review",
}: {
  queue?: keyof typeof QUEUES;
}) {
  const tm = useTranslations("dashboardSkillsMarket");
  const ta = useTranslations("dashboardAdmin");
  const {
    section,
    takesReason,
    load: loadQueue,
    approve,
    decline,
  } = QUEUES[queue];
  const [items, setItems] = React.useState<QueueItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [skillMd, setSkillMd] = React.useState<Record<string, SkillMdState>>(
    {},
  );
  const [reasons, setReasons] = React.useState<Record<string, string>>({});
  // Scan flags in words; an unknown flag is shown as it is.
  const flagLabels = tm.raw("flagLabels") as Record<string, string>;

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await loadQueue();
      setItems(result.items);
    } catch (caught) {
      const status = (caught as { status?: number } | null)?.status;
      setError(
        status === 403
          ? tm(`${section}.forbidden`)
          : tm(`${section}.loadFailed`),
      );
      setItems([]);
    }
  }, [loadQueue, section, tm]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function loadSkillMd(item: QueueItem) {
    const key = item.skillVersionId;
    setSkillMd((prev) => ({ ...prev, [key]: { status: "loading" } }));
    try {
      const detail = await getSkillReviewVersion(item.skillId, key);
      setSkillMd((prev) => ({
        ...prev,
        [key]: { status: "ready", content: detail.skillContent },
      }));
    } catch {
      setSkillMd((prev) => ({ ...prev, [key]: { status: "error" } }));
    }
  }

  function toggleExpanded(item: QueueItem) {
    const key = item.skillVersionId;
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    const current = skillMd[key];
    if (opening && (!current || current.status === "error")) {
      void loadSkillMd(item);
    }
  }

  async function act(item: QueueItem, action: "publish" | "reject") {
    const key = item.skillVersionId;
    setBusy((prev) => new Set(prev).add(key));
    try {
      await (action === "publish" ? approve : decline)(item, reasons[key]);
      setItems((prev) =>
        prev ? prev.filter((entry) => entry.skillVersionId !== key) : prev,
      );
    } catch {
      setError(tm("review.actionFailed", { slug: item.slug }));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className={queue === "listing" ? "mt-12" : undefined}>
      {queue === "review" ? (
        <h1 className="text-2xl font-semibold tracking-tight">
          {tm(`${section}.title`)}
        </h1>
      ) : (
        <h2 className="text-xl font-semibold tracking-tight">
          {tm(`${section}.title`)}
        </h2>
      )}
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {tm(`${section}.intro`)}
      </p>

      {error ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {tm(`${section}.loading`)}
        </div>
      ) : items.length === 0 && !error ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <p className="text-sm">{tm(`${section}.empty`)}</p>
        </div>
      ) : (
        <div className="mt-6 divide-y overflow-hidden rounded-xl border">
          {items.map((item) => {
            const key = item.skillVersionId;
            const critical = item.flags.some(isCriticalSkillFlag);
            const isBusy = busy.has(key);
            const isExpanded = expanded.has(key);
            const skillDoc = skillMd[key];
            const publicUpdate = queue === "listing" && isPublicUpdate(item);
            const changes = item.changes ?? null;
            const compareUrl =
              changes?.compareUrl &&
              /^https:\/\/github\.com\//.test(changes.compareUrl)
                ? changes.compareUrl
                : null;
            return (
              <div
                key={key}
                className={`border-l-[3px] p-5 ${
                  critical ? "border-l-destructive" : "border-l-amber-500"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{item.displayName}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {item.slug}
                      </code>
                      {queue === "listing" && item.reason ? (
                        <Badge variant={publicUpdate ? "default" : "outline"}>
                          {tm.has(`listingQueue.reasons.${item.reason}`)
                            ? tm(`listingQueue.reasons.${item.reason}`)
                            : item.reason}
                        </Badge>
                      ) : null}
                    </div>
                    {item.description ? (
                      <p className="mt-1 line-clamp-2 max-w-2xl text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {item.sourceUrl &&
                      /^https?:\/\//i.test(item.sourceUrl) ? (
                        <a
                          className="inline-flex max-w-full items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                          href={item.sourceUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          <span className="truncate">
                            {item.sourceUrl.replace(/^https?:\/\//, "")}
                          </span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ) : null}
                      {item.capability ? (
                        <span>
                          {item.capability === "executable"
                            ? tm("review.capabilityExecutable")
                            : tm("review.capabilityPromptOnly")}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <Scale className="size-3" />
                        {item.license ?? tm("review.noLicense")}
                      </span>
                      {item.submittedBy ? (
                        <span title={item.submittedBy}>
                          {tm("review.submittedBy", {
                            who: item.submittedByName || item.submittedBy,
                          })}
                        </span>
                      ) : null}
                      <span>{relativeTime(item.createdAt, ta)}</span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {item.flags.map((flag) => (
                        <Badge
                          key={flag}
                          variant={
                            isCriticalSkillFlag(flag)
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          ⚠ {skillFlagLabel(flag, flagLabels)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      disabled={isBusy}
                      onClick={() => void act(item, "publish")}
                      size="sm"
                    >
                      {isBusy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="size-4" />
                      )}
                      {publicUpdate
                        ? tm("listingQueue.keepPublic")
                        : tm(`${section}.publish`)}
                    </Button>
                    <Button
                      disabled={isBusy}
                      onClick={() => void act(item, "reject")}
                      size="sm"
                      variant="outline"
                    >
                      <XCircle className="size-4" />
                      {publicUpdate
                        ? tm("listingQueue.withdraw")
                        : tm(`${section}.reject`)}
                    </Button>
                  </div>
                </div>

                {changes ? (
                  <div
                    className="mt-3 space-y-0.5 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                    data-testid="listing-queue-changes"
                  >
                    <p className="font-medium text-foreground">
                      {tm("listingQueue.changesTitle")}
                    </p>
                    {changes.newScripts.length > 0 ? (
                      <p className="text-amber-700 dark:text-amber-300">
                        {tm("listingQueue.changesNewScripts", {
                          paths: changes.newScripts.join(", "),
                        })}
                      </p>
                    ) : null}
                    {changes.newFlags.length > 0 ? (
                      <p className="text-amber-700 dark:text-amber-300">
                        {tm("listingQueue.changesNewFlags", {
                          flags: changes.newFlags
                            .map((flag) => skillFlagLabel(flag, flagLabels))
                            .join(", "),
                        })}
                      </p>
                    ) : null}
                    {changes.added.length > 0 ? (
                      <p className="break-all">
                        {tm("listingQueue.changesAdded", {
                          paths: changes.added.join(", "),
                        })}
                      </p>
                    ) : null}
                    {changes.modified.length > 0 ? (
                      <p className="break-all">
                        {tm("listingQueue.changesModified", {
                          paths: changes.modified.join(", "),
                        })}
                      </p>
                    ) : null}
                    {changes.removed.length > 0 ? (
                      <p className="break-all">
                        {tm("listingQueue.changesRemoved", {
                          paths: changes.removed.join(", "),
                        })}
                      </p>
                    ) : null}
                    {compareUrl ? (
                      <a
                        className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                        href={compareUrl}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {tm("listingQueue.compare")}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    aria-expanded={isExpanded}
                    className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => toggleExpanded(item)}
                    type="button"
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    {isExpanded
                      ? tm("review.hideSkillMd")
                      : tm("review.readSkillMd")}
                  </button>
                  {takesReason ? (
                    <Input
                      aria-label={tm("review.reasonLabel")}
                      className="h-8 text-xs sm:max-w-xs"
                      disabled={isBusy}
                      maxLength={1000}
                      onChange={(event) =>
                        setReasons((prev) => ({
                          ...prev,
                          [key]: event.target.value,
                        }))
                      }
                      placeholder={`${tm("review.reasonLabel")} — ${tm("review.reasonPlaceholder")}`}
                      value={reasons[key] ?? ""}
                    />
                  ) : null}
                </div>

                {isExpanded ? (
                  <div className="mt-3 max-h-[480px] overflow-y-auto rounded-lg border bg-muted/20 px-4 py-3">
                    {!skillDoc || skillDoc.status === "loading" ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {tm("review.loadingSkillMd")}
                      </div>
                    ) : skillDoc.status === "error" ? (
                      <p className="text-xs text-destructive">
                        {tm("review.skillMdFailed")}
                      </p>
                    ) : skillDoc.content ? (
                      // Raw source, not rendered markdown: a reviewer has to see
                      // what the model will read, and rendering would hide HTML
                      // comments and other text an injection can live in.
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                        {skillDoc.content}
                      </pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {tm("review.skillMdMissing")}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        {tm(`${section}.footnote`)}
      </p>
    </div>
  );
}
