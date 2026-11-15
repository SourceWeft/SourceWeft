"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type {
  BlogAdminPost,
  BlogAdminPostDetail,
  BlogAdminPostStatus,
} from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  getBlogAdminPost,
  listBlogAdminPosts,
  setBlogAdminPostStatus,
} from "../../../../../lib/blog-admin";
import { errorMessage } from "../../../../../lib/skill-market-audit";
import {
  BLOG_ADMIN_HREF,
  VISIBILITY_VARIANT,
  blogArticleAdminHref,
  blogPostPublicPath,
  groupBlogPosts,
  visibilityOf,
} from "./blog-posts";

/** One article: its language versions, what each one's status is, and a preview. */
export function BlogArticle({
  articleId,
  initialLocale,
}: {
  articleId: string;
  initialLocale?: string;
}) {
  const t = useTranslations("dashboardBlogAdmin");
  const locale = useLocale();
  const [posts, setPosts] = React.useState<BlogAdminPost[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [chosenLocale, setChosenLocale] = React.useState(initialLocale);
  const [detail, setDetail] = React.useState<BlogAdminPostDetail | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<BlogAdminPostStatus | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void listBlogAdminPosts()
      .then((response) => {
        if (!cancelled) setPosts(response.items);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught, t("loadFailed")));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const group = React.useMemo(
    () => groupBlogPosts(posts ?? []).find((entry) => entry.articleId === articleId),
    [posts, articleId],
  );
  const selected =
    group?.versions.find((post) => post.locale === chosenLocale) ?? group?.versions[0];
  const selectedId = selected?.id;

  React.useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    void getBlogAdminPost(selectedId)
      .then((post) => {
        if (!cancelled) setDetail(post);
      })
      .catch((caught) => {
        if (!cancelled) setDetailError(errorMessage(caught, t("previewFailed")));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, t]);

  const formatDate = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
      : t("never");

  function chooseLocale(next: string) {
    setChosenLocale(next);
    // Keep the address on the version being looked at, so a reload stays there.
    window.history.replaceState(null, "", blogArticleAdminHref(articleId, next));
  }

  async function changeStatus(next: BlogAdminPostStatus) {
    if (!selected) return;
    setPending(next);
    setDetailError(null);
    try {
      const updated = await setBlogAdminPostStatus(selected.id, next);
      setDetail(updated);
      setPosts((current) =>
        (current ?? []).map((post) =>
          post.id === updated.id
            ? { ...post, status: updated.status, syncEnabled: updated.syncEnabled, publishedAt: updated.publishedAt }
            : post,
        ),
      );
    } catch (caught) {
      setDetailError(errorMessage(caught, t("statusFailed")));
    } finally {
      setPending(null);
    }
  }

  const back = (
    <Link
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      href={BLOG_ADMIN_HREF}
    >
      <ArrowLeft className="size-4" />
      {t("detail.back")}
    </Link>
  );

  if (error) {
    return (
      <>
        {back}
        <p className="mt-6 text-sm text-destructive" role="alert">
          {error}
        </p>
      </>
    );
  }
  if (posts === null) {
    return (
      <>
        {back}
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("loading")}
        </p>
      </>
    );
  }
  if (!group || !selected) {
    return (
      <>
        {back}
        <p className="mt-6 text-sm text-muted-foreground">{t("detail.notFound", { articleId })}</p>
      </>
    );
  }

  const visibility = visibilityOf(selected);

  return (
    <>
      {back}
      <div className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">{selected.title}</h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {group.articleId}
          {group.category ? ` · ${group.category}` : ""}
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <div aria-label={t("detail.languages")} className="flex flex-wrap gap-1" role="tablist">
          {group.versions.map((post) => (
            <Button
              aria-selected={post.id === selected.id}
              key={post.id}
              onClick={() => chooseLocale(post.locale)}
              role="tab"
              size="sm"
              variant={post.id === selected.id ? "secondary" : "ghost"}
            >
              {post.locale} · {t(`visibility.${visibilityOf(post)}`)}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {visibility === "published" ? (
            <Button asChild size="sm" variant="ghost">
              <a href={blogPostPublicPath(selected)} rel="noreferrer" target="_blank">
                <ExternalLink className="size-4" />
                {t("detail.viewLive")}
              </a>
            </Button>
          ) : null}
          {visibility === "published" ? (
            <Button
              disabled={pending !== null}
              onClick={() => void changeStatus("draft")}
              size="sm"
              variant="outline"
            >
              {pending === "draft" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("detail.unpublish")}
            </Button>
          ) : (
            <Button
              disabled={pending !== null}
              onClick={() => void changeStatus("published")}
              size="sm"
            >
              {pending === "published" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("detail.publish")}
            </Button>
          )}
          {selected.status !== "archived" ? (
            <Button
              disabled={pending !== null}
              onClick={() => void changeStatus("archived")}
              size="sm"
              variant="ghost"
            >
              {pending === "archived" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("detail.archive")}
            </Button>
          ) : null}
        </div>
      </div>

      {detailError ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {detailError}
        </p>
      ) : null}

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-label={t("detail.preview")} className="min-w-0 rounded-lg border border-border px-6 py-6">
          <p className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("detail.preview")}
          </p>
          {detail ? (
            <div className="mx-auto max-w-3xl">
              <h2 className="mb-6 text-3xl font-semibold tracking-tight">{detail.title}</h2>
              {/* The body is HTML our own renderers produced from Markdown or
                  Notion blocks, with source markup escaped. */}
              <article
                className="blog-content"
                dangerouslySetInnerHTML={{ __html: detail.contentHtml }}
              />
            </div>
          ) : detailError ? null : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("detail.loadingPreview")}
            </p>
          )}
        </section>

        <aside aria-label={t("detail.label")} className="lg:order-last">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.status")}</dt>
              <dd className="mt-1">
                <Badge variant={VISIBILITY_VARIANT[visibility]}>{t(`visibility.${visibility}`)}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.address")}</dt>
              <dd className="mt-1 break-all font-mono text-xs">{blogPostPublicPath(selected)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.published")}</dt>
              <dd className="mt-1">{formatDate(selected.publishedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.imported")}</dt>
              <dd className="mt-1">{formatDate(selected.syncedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.source")}</dt>
              <dd className="mt-1">{t(`source.${selected.source}`)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.readingTime")}</dt>
              <dd className="mt-1">{t("detail.minutes", { count: selected.readingTimeMinutes })}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("detail.excerpt")}</dt>
              <dd className="mt-1 text-muted-foreground">{selected.excerpt}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </>
  );
}
