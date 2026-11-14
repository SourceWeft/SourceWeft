"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookmarkCheck, Pencil } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { NoteOrigin } from "@sourceweft/contracts/sources";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../lib/sdk";

const SHOWN_REFERENCES = 3;

/**
 * Where a saved note came from: the conversation it was saved from (only when
 * the viewer can read it), when it was saved and last edited, and the sources
 * its answer cited with the passage that backed each claim at the time. It is
 * the snapshot taken at save time, so editing the note does not change it.
 */
export function NoteOriginCard({
  onEdit,
  onOpenSource,
  reloadKey = 0,
  sourceId,
  workspaceId,
}: {
  onEdit?: () => void;
  onOpenSource?: (source: { id: string; title: string }) => void;
  reloadKey?: number;
  sourceId: string;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const locale = useLocale();
  const [origin, setOrigin] = useState<NoteOrigin | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    contentClient
      .getNoteOrigin(workspaceId, sourceId)
      .then((result) => {
        if (!cancelled) setOrigin(result.origin);
      })
      .catch(() => {
        if (!cancelled) setOrigin(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, sourceId, workspaceId]);

  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      new Date(iso),
    );
  const references = origin?.references ?? [];
  const visible = expanded ? references : references.slice(0, SHOWN_REFERENCES);

  return (
    <section
      className="shrink-0 border-b bg-muted/15 px-5 py-3 lg:px-8"
      data-note-origin
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <BookmarkCheck className="size-4 shrink-0 text-primary" />
          <span className="truncate">{t("noteOrigin.title")}</span>
        </div>
        {onEdit ? (
          <Button
            className="shrink-0 gap-1.5"
            onClick={onEdit}
            size="xs"
            type="button"
            variant="outline"
          >
            <Pencil className="size-3.5" />
            {t("noteOrigin.edit")}
          </Button>
        ) : null}
      </div>

      {origin ? (
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p data-note-origin-saved>
            {origin.thread ? (
              <>
                {t("noteOrigin.savedFrom")}{" "}
                <Link
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  href={`/dashboard/chat/${origin.thread.id}`}
                >
                  {origin.thread.title}
                </Link>
                {" · "}
              </>
            ) : null}
            {t("noteOrigin.savedOn", { date: date(origin.savedAt) })}
            {origin.editedAt
              ? ` · ${t("noteOrigin.editedOn", { date: date(origin.editedAt) })}`
              : ""}
          </p>

          {references.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-medium">
                {t("noteOrigin.cited")}
              </div>
              <ul className="space-y-1.5">
                {visible.map((reference) => (
                  <li
                    className="rounded-lg bg-background/60 px-2.5 py-1.5"
                    data-note-reference={reference.number}
                    key={reference.number}
                  >
                    <div className="flex items-baseline gap-2 text-foreground">
                      <span className="text-xs text-muted-foreground">
                        [{reference.number}]
                      </span>
                      {reference.sourceExists &&
                      reference.sourceId &&
                      onOpenSource ? (
                        <button
                          className="truncate text-left text-sm font-medium underline-offset-2 hover:underline"
                          onClick={() =>
                            onOpenSource({
                              id: reference.sourceId!,
                              title: reference.sourceTitle ?? "",
                            })
                          }
                          type="button"
                        >
                          {reference.sourceTitle || t("noteOrigin.untitled")}
                        </button>
                      ) : (
                        <span className="truncate text-sm">
                          {reference.sourceTitle || t("noteOrigin.untitled")}
                        </span>
                      )}
                      {reference.sourceId && !reference.sourceExists ? (
                        <span className="text-xs text-muted-foreground">
                          {t("noteOrigin.sourceDeleted")}
                        </span>
                      ) : null}
                    </div>
                    {reference.passage ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5">
                        “{reference.passage}”
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {references.length > SHOWN_REFERENCES ? (
                <Button
                  className="mt-1 px-1"
                  onClick={() => setExpanded((value) => !value)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {expanded
                    ? t("noteOrigin.showLess")
                    : t("noteOrigin.showAll", { count: references.length })}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
