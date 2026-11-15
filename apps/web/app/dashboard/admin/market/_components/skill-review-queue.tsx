"use client";

import * as React from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Scale,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useAdminOverview } from "../../_components/admin-overview-context";
import {
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminList,
  AdminLoading,
} from "../../_components/admin-ui";
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
 * would not publish on its own. The queue is a list on one side and the chosen
 * skill on the other: a reviewer reads the flags and the SKILL.md, then
 * publishes or rejects, optionally recording why.
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
  const { refresh: refreshOverview } = useAdminOverview();
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
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

  // The skill being read: the chosen one, or the first while none is chosen
  // or the chosen one has been decided and left the queue.
  const selected =
    items?.find((item) => item.skillVersionId === selectedKey) ?? items?.[0];
  const selectedVersionId = selected?.skillVersionId;
  const selectedSkillId = selected?.skillId;

  React.useEffect(() => {
    if (!selectedVersionId || !selectedSkillId) return;
    let cancelled = false;
    setSkillMd((prev) =>
      prev[selectedVersionId]?.status === "ready"
        ? prev
        : { ...prev, [selectedVersionId]: { status: "loading" } },
    );
    void getSkillReviewVersion(selectedSkillId, selectedVersionId)
      .then((detail) => {
        if (cancelled) return;
        setSkillMd((prev) => ({
          ...prev,
          [selectedVersionId]: {
            status: "ready",
            content: detail.skillContent,
          },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setSkillMd((prev) => ({
          ...prev,
          [selectedVersionId]: { status: "error" },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSkillId, selectedVersionId]);

  async function act(item: QueueItem, action: "publish" | "reject") {
    const key = item.skillVersionId;
    setBusy((prev) => new Set(prev).add(key));
    try {
      await (action === "publish" ? approve : decline)(item, reasons[key]);
      setItems((prev) =>
        prev ? prev.filter((entry) => entry.skillVersionId !== key) : prev,
      );
      refreshOverview();
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

  function renderDetail(item: QueueItem) {
    const key = item.skillVersionId;
    const isBusy = busy.has(key);
    const skillDoc = skillMd[key];
    const publicUpdate = queue === "listing" && isPublicUpdate(item);
    const changes = item.changes ?? null;
    const compareUrl =
      changes?.compareUrl && /^https:\/\/github\.com\//.test(changes.compareUrl)
        ? changes.compareUrl
        : null;
    return (
      <section
        aria-label={item.displayName}
        className="min-w-0 rounded-xl border p-5"
        data-testid="review-detail"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-base font-semibold">{item.displayName}</h3>
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
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {item.description}
              </p>
            ) : null}
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

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) ? (
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

        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.flags.map((flag) => (
            <Badge
              key={flag}
              variant={isCriticalSkillFlag(flag) ? "destructive" : "secondary"}
            >
              ⚠ {skillFlagLabel(flag, flagLabels)}
            </Badge>
          ))}
        </div>

        {changes ? (
          <div
            className="mt-4 space-y-0.5 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
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

        {takesReason ? (
          <Input
            aria-label={tm("review.reasonLabel")}
            className="mt-4 h-8 text-xs sm:max-w-md"
            disabled={isBusy}
            maxLength={1000}
            onChange={(event) =>
              setReasons((prev) => ({ ...prev, [key]: event.target.value }))
            }
            placeholder={`${tm("review.reasonLabel")} — ${tm("review.reasonPlaceholder")}`}
            value={reasons[key] ?? ""}
          />
        ) : null}

        <p className="mt-5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          SKILL.md
        </p>
        <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/20 px-4 py-3">
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
      </section>
    );
  }

  return (
    <div className={queue === "listing" ? "mt-12" : undefined}>
      <AdminHeader
        description={tm(`${section}.intro`)}
        level={queue === "review" ? 1 : 2}
        title={
          <>
            {tm(`${section}.title`)}
            {items && items.length > 0 ? (
              <Badge className="ml-2 align-middle" variant="secondary">
                {items.length}
              </Badge>
            ) : null}
          </>
        }
      />

      {error ? <AdminError className="mt-6">{error}</AdminError> : null}

      {items === null ? (
        <AdminLoading className="mt-4">{tm(`${section}.loading`)}</AdminLoading>
      ) : items.length === 0 || !selected ? (
        error ? null : (
          <AdminEmpty className="mt-6" done>
            {tm(`${section}.empty`)}
          </AdminEmpty>
        )
      ) : (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <AdminList className="lg:sticky lg:top-0 lg:max-h-[80vh] lg:overflow-y-auto">
            {items.map((item) => {
              const active = item.skillVersionId === selected.skillVersionId;
              const critical = item.flags.some(isCriticalSkillFlag);
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "block w-full border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                    critical ? "border-l-destructive" : "border-l-amber-500",
                    active && "bg-muted",
                  )}
                  data-testid="review-row"
                  key={item.skillVersionId}
                  onClick={() => setSelectedKey(item.skillVersionId)}
                  type="button"
                >
                  <span className="block truncate text-sm font-medium">
                    {item.displayName}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {item.slug}
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {tm("review.flagCount", { count: item.flags.length })}
                    </span>
                    <span className="shrink-0">
                      {relativeTime(item.createdAt, ta)}
                    </span>
                  </span>
                </button>
              );
            })}
          </AdminList>
          {renderDetail(selected)}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        {tm(`${section}.footnote`)}
      </p>
    </div>
  );
}
