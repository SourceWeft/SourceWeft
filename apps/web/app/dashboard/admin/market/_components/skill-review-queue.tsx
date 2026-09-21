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
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
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
import { skillsMarketCopy } from "../../../skills/_components/skills-market-copy";

type QueueItem = SkillListingQueueEntry;

/**
 * The two admin queues look and behave alike — a flagged skill, its SKILL.md to
 * read, and a yes/no — and differ in what the answer does:
 * - `review`: a flagged DRAFT version. Approve publishes it, reject deprecates.
 * - `listing`: a PUBLISHED skill with an advisory flag. Yes lists it publicly,
 *   no keeps it private and holds it. There is no reason to record.
 */
const QUEUES = {
  review: {
    copy: skillsMarketCopy.review,
    takesReason: true,
    load: listSkillReviewQueue,
    approve: (item: QueueItem, reason?: string) =>
      publishSkillSubmission(item.skillVersionId, reason),
    decline: (item: QueueItem, reason?: string) =>
      rejectSkillSubmission(item.skillVersionId, reason),
  },
  listing: {
    copy: { ...skillsMarketCopy.review, ...skillsMarketCopy.listingQueue },
    takesReason: false,
    load: listSkillListingQueue,
    approve: (item: QueueItem) => listSkillPublicly(item.skillId),
    decline: (item: QueueItem) => delistSkill(item.skillId),
  },
} as const;

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
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
  const {
    copy,
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

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await loadQueue();
      setItems(result.items);
    } catch (caught) {
      const status = (caught as { status?: number } | null)?.status;
      setError(status === 403 ? copy.forbidden : copy.loadFailed);
      setItems([]);
    }
  }, [copy, loadQueue]);

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
      setError(copy.actionFailed(item.slug));
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
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      ) : (
        <h2 className="text-xl font-semibold tracking-tight">{copy.title}</h2>
      )}
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {copy.intro}
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
          {copy.loading}
        </div>
      ) : items.length === 0 && !error ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-muted-foreground">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <p className="text-sm">{copy.empty}</p>
        </div>
      ) : (
        <div className="mt-6 divide-y overflow-hidden rounded-xl border">
          {items.map((item) => {
            const key = item.skillVersionId;
            const critical = item.flags.some(isCriticalSkillFlag);
            const isBusy = busy.has(key);
            const isExpanded = expanded.has(key);
            const skillDoc = skillMd[key];
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
                            ? copy.capabilityExecutable
                            : copy.capabilityPromptOnly}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <Scale className="size-3" />
                        {item.license ?? copy.noLicense}
                      </span>
                      {item.submittedBy ? (
                        <span>{copy.submittedBy(item.submittedBy)}</span>
                      ) : null}
                      <span>{relativeTime(item.createdAt)}</span>
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
                          ⚠ {skillFlagLabel(flag, skillsMarketCopy.flagLabels)}
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
                      {copy.publish}
                    </Button>
                    <Button
                      disabled={isBusy}
                      onClick={() => void act(item, "reject")}
                      size="sm"
                      variant="outline"
                    >
                      <XCircle className="size-4" />
                      {copy.reject}
                    </Button>
                  </div>
                </div>

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
                    {isExpanded ? copy.hideSkillMd : copy.readSkillMd}
                  </button>
                  {takesReason ? (
                    <Input
                      aria-label={copy.reasonLabel}
                      className="h-8 text-xs sm:max-w-xs"
                      disabled={isBusy}
                      maxLength={1000}
                      onChange={(event) =>
                        setReasons((prev) => ({
                          ...prev,
                          [key]: event.target.value,
                        }))
                      }
                      placeholder={`${copy.reasonLabel} — ${copy.reasonPlaceholder}`}
                      value={reasons[key] ?? ""}
                    />
                  ) : null}
                </div>

                {isExpanded ? (
                  <div className="mt-3 max-h-[480px] overflow-y-auto rounded-lg border bg-muted/20 px-4 py-3">
                    {!skillDoc || skillDoc.status === "loading" ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {copy.loadingSkillMd}
                      </div>
                    ) : skillDoc.status === "error" ? (
                      <p className="text-xs text-destructive">
                        {copy.skillMdFailed}
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
                        {copy.skillMdMissing}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">{copy.footnote}</p>
    </div>
  );
}
