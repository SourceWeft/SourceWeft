"use client";

import * as React from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import {
  createSkillCollection,
  deleteSkillCollection,
  listSkillCollections,
  setSkillCollectionItems,
  updateSkillCollection,
  type SkillCollectionAdmin,
} from "../../../../../lib/skill-market-admin";

/** Slugs typed one per line (commas too), blanks dropped, order kept. */
export function parseCollectionSlugs(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** The server's own message, or ours; `t` is `dashboardSkillsMarket`. */
function errorMessage(error: unknown, t: ReturnType<typeof useTranslations>) {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message
    ? message
    : t("collections.failed");
}

/**
 * One collection: its title, summary, position and published switch, and its
 * skills as slugs in order. Each part saves on its own button, so fixing a
 * typo in the title never re-sends the skill list.
 */
function CollectionEditor({
  collection,
  onChange,
  onDelete,
}: {
  collection: SkillCollectionAdmin;
  onChange: (next: SkillCollectionAdmin) => void;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("dashboardSkillsMarket");
  const [title, setTitle] = React.useState(collection.title);
  const [summary, setSummary] = React.useState(collection.summary);
  const [position, setPosition] = React.useState(String(collection.position));
  const [slugs, setSlugs] = React.useState(
    collection.items.map((item) => item.slug).join("\n"),
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function run(action: () => Promise<SkillCollectionAdmin | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await action();
      if (next) {
        onChange(next);
        setSlugs(next.items.map((item) => item.slug).join("\n"));
      }
      setMessage(t("collections.saved"));
    } catch (error) {
      setMessage(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  const positionNumber = Number(position);
  return (
    <div className="space-y-4 p-5" data-testid={`collection-${collection.slug}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{collection.title}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {collection.slug}
          </code>
          <Badge variant="outline">{t("collections.skillCount", { count: collection.items.length })}</Badge>
          {collection.published ? (
            <a
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              href={`/skills/collections/${encodeURIComponent(collection.slug)}`}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t("collections.view")}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              aria-label={t("collections.publishedLabel")}
              checked={collection.published}
              disabled={busy}
              onCheckedChange={(checked) =>
                void run(() =>
                  updateSkillCollection(collection.id, {
                    published: Boolean(checked),
                  }),
                )
              }
            />
            {t("collections.publishedLabel")}
          </label>
          <Button
            disabled={busy}
            onClick={() => {
              if (window.confirm(
                  t("collections.confirmDelete", { title: collection.title }),
                )) {
                void run(async () => {
                  await deleteSkillCollection(collection.id);
                  onDelete(collection.id);
                });
              }
            }}
            size="sm"
            variant="outline"
          >
            <Trash2 className="size-4" />
            {t("collections.delete")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Input
          aria-label={t("collections.titleLabel")}
          disabled={busy}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("collections.titleLabel")}
          value={title}
        />
        <Input
          aria-label={t("collections.positionLabel")}
          disabled={busy}
          inputMode="numeric"
          onChange={(event) => setPosition(event.target.value)}
          placeholder={t("collections.positionLabel")}
          value={position}
        />
        <Textarea
          aria-label={t("collections.summaryLabel")}
          className="sm:col-span-2"
          disabled={busy}
          maxLength={500}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={t("collections.summaryLabel")}
          rows={2}
          value={summary}
        />
      </div>
      <Button
        disabled={
          busy ||
          !title.trim() ||
          !Number.isInteger(positionNumber) ||
          positionNumber < 0
        }
        onClick={() =>
          void run(() =>
            updateSkillCollection(collection.id, {
              title: title.trim(),
              summary: summary.trim(),
              position: positionNumber,
            }),
          )
        }
        size="sm"
      >
        <Save className="size-4" />
        {t("collections.save")}
      </Button>

      <div className="space-y-2">
        <Textarea
          aria-label={t("collections.skillsLabel")}
          className="font-mono text-xs"
          disabled={busy}
          onChange={(event) => setSlugs(event.target.value)}
          placeholder={t("collections.skillsLabel")}
          rows={Math.min(12, Math.max(3, collection.items.length + 1))}
          value={slugs}
        />
        {collection.items.some((item) => !item.public) ? (
          <p className="text-xs text-muted-foreground">
            {collection.items
              .filter((item) => !item.public)
              .map((item) => `${item.slug} (${t("collections.notPublic")})`)
              .join(", ")}
          </p>
        ) : null}
        <Button
          disabled={busy}
          onClick={() =>
            void run(() =>
              setSkillCollectionItems(
                collection.id,
                parseCollectionSlugs(slugs),
              ),
            )
          }
          size="sm"
          variant="outline"
        >
          <Save className="size-4" />
          {t("collections.saveSkills")}
        </Button>
      </div>

      {message ? (
        <p className="text-xs text-muted-foreground" role="status">
          {busy ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The market admin's editorial collections: create one, edit its text and
 * skills, publish it to the public directory, delete it.
 */
export function SkillCollectionsAdmin() {
  const t = useTranslations("dashboardSkillsMarket");
  const [items, setItems] = React.useState<SkillCollectionAdmin[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [slug, setSlug] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      setItems((await listSkillCollections()).items);
    } catch (caught) {
      const status = (caught as { status?: number } | null)?.status;
      setError(status === 403 ? t("collections.forbidden") : t("collections.loadFailed"));
      setItems([]);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await createSkillCollection({
        slug: slug.trim(),
        title: title.trim(),
      });
      setItems((prev) => [...(prev ?? []), created]);
      setSlug("");
      setTitle("");
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("collections.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t("collections.intro")}
      </p>

      <form
        className="mt-6 flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-end"
        onSubmit={(event) => void create(event)}
      >
        <div className="flex-1 space-y-1">
          <p className="text-xs font-medium">{t("collections.newTitle")}</p>
          <Input
            aria-label={t("collections.slugLabel")}
            disabled={creating}
            maxLength={64}
            onChange={(event) => setSlug(event.target.value)}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder={t("collections.slugPlaceholder")}
            title={t("collections.slugHint")}
            value={slug}
          />
        </div>
        <Input
          aria-label={t("collections.titleLabel")}
          className="flex-1"
          disabled={creating}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("collections.titleLabel")}
          value={title}
        />
        <Button
          disabled={creating || !slug.trim() || !title.trim()}
          size="sm"
          type="submit"
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {t("collections.create")}
        </Button>
      </form>

      {error ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("collections.loading")}
        </div>
      ) : items.length === 0 ? (
        error ? null : (
          <p className="mt-10 rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            {t("collections.empty")}
          </p>
        )
      ) : (
        <div className="mt-6 divide-y overflow-hidden rounded-xl border">
          {items.map((collection) => (
            <CollectionEditor
              collection={collection}
              key={collection.id}
              onChange={(next) =>
                setItems((prev) =>
                  prev
                    ? prev.map((entry) => (entry.id === next.id ? next : entry))
                    : prev,
                )
              }
              onDelete={(id) =>
                setItems((prev) =>
                  prev ? prev.filter((entry) => entry.id !== id) : prev,
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
