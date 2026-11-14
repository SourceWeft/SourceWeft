"use client";

import * as React from "react";
import { ExternalLink, Loader2, Newspaper, RefreshCw, Search, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type {
  BlogAdminPost,
  BlogAdminPostDetail,
  BlogAdminPostStatus,
  ImportBlogMarkdownResponse,
} from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";

import {
  getBlogAdminPost,
  importBlogMarkdown,
  importProblems,
  listBlogAdminPosts,
  setBlogAdminPostStatus,
} from "../../../../../lib/blog-admin";
import { errorMessage } from "../../../../../lib/skill-market-audit";

/** What a reader can see: `hidden` is a published row with sync turned off. */
export type BlogPostVisibility = "published" | "draft" | "archived" | "hidden";
type StatusFilter = "all" | BlogPostVisibility;

const LOCALE_ORDER = ["en", "zh-CN", "zh-TW"];
const FILTERS: StatusFilter[] = ["all", "published", "draft", "archived", "hidden"];

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground";

export function visibilityOf(post: Pick<BlogAdminPost, "status" | "syncEnabled">): BlogPostVisibility {
  if (post.status === "published") return post.syncEnabled ? "published" : "hidden";
  return post.status;
}

export type BlogArticleGroup = {
  articleId: string;
  title: string;
  category: string | null;
  syncedAt: string;
  versions: BlogAdminPost[];
};

function localeRank(locale: string) {
  const index = LOCALE_ORDER.indexOf(locale);
  return index === -1 ? LOCALE_ORDER.length : index;
}

/** One entry per article, its language versions in a fixed order, newest first. */
export function groupBlogPosts(posts: BlogAdminPost[]): BlogArticleGroup[] {
  const byArticle = new Map<string, BlogAdminPost[]>();
  for (const post of posts) {
    const versions = byArticle.get(post.articleId) ?? [];
    versions.push(post);
    byArticle.set(post.articleId, versions);
  }
  return [...byArticle.entries()]
    .map(([articleId, versions]) => {
      const sorted = [...versions].sort(
        (a, b) => localeRank(a.locale) - localeRank(b.locale) || a.locale.localeCompare(b.locale),
      );
      const lead = sorted[0]!;
      return {
        articleId,
        title: lead.title,
        category: lead.category,
        syncedAt: sorted.map((post) => post.syncedAt).sort().at(-1) ?? lead.syncedAt,
        versions: sorted,
      };
    })
    .sort((a, b) => b.syncedAt.localeCompare(a.syncedAt) || a.articleId.localeCompare(b.articleId));
}

export function filterBlogGroups(
  groups: BlogArticleGroup[],
  query: string,
  status: StatusFilter,
): BlogArticleGroup[] {
  const needle = query.trim().toLowerCase();
  return groups.filter((group) => {
    const matchesQuery =
      !needle ||
      group.articleId.toLowerCase().includes(needle) ||
      group.versions.some(
        (post) => post.title.toLowerCase().includes(needle) || post.slug.toLowerCase().includes(needle),
      );
    const matchesStatus =
      status === "all" || group.versions.some((post) => visibilityOf(post) === status);
    return matchesQuery && matchesStatus;
  });
}

/** The public address of a post, in its own language. */
export function blogPostPublicPath(post: Pick<BlogAdminPost, "locale" | "slug">) {
  return `${post.locale === "en" ? "" : `/${post.locale}`}/blog/${post.slug}`;
}

const VISIBILITY_VARIANT: Record<BlogPostVisibility, "default" | "secondary" | "outline" | "destructive"> = {
  published: "default",
  draft: "secondary",
  archived: "outline",
  hidden: "destructive",
};

type ImportState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: ImportBlogMarkdownResponse }
  | { kind: "failed"; message: string; problems: Array<{ path: string; message: string }> };

export function BlogAdmin() {
  const t = useTranslations("dashboardBlogAdmin");
  const locale = useLocale();
  const [posts, setPosts] = React.useState<BlogAdminPost[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<BlogAdminPostDetail | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<BlogAdminPostStatus | null>(null);
  const [importState, setImportState] = React.useState<ImportState>({ kind: "idle" });
  const fileInput = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const response = await listBlogAdminPosts();
      setPosts(response.items);
    } catch (caught) {
      setPosts((current) => current ?? []);
      setError(errorMessage(caught, t("loadFailed")));
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
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

  const groups = React.useMemo(() => groupBlogPosts(posts ?? []), [posts]);
  const visible = React.useMemo(
    () => filterBlogGroups(groups, query, status),
    [groups, query, status],
  );
  const selectedGroup = groups.find((group) =>
    group.versions.some((post) => post.id === selectedId),
  );
  const selectedPost = selectedGroup?.versions.find((post) => post.id === selectedId);

  const formatDate = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
      : t("never");

  async function changeStatus(next: BlogAdminPostStatus) {
    if (!selectedPost) return;
    setPending(next);
    setDetailError(null);
    try {
      const updated = await setBlogAdminPostStatus(selectedPost.id, next);
      setDetail(updated);
      setPosts((current) =>
        (current ?? []).map((post) => {
          if (post.id !== updated.id) return post;
          const { contentHtml: _contentHtml, ...summary } = updated;
          return summary;
        }),
      );
    } catch (caught) {
      setDetailError(errorMessage(caught, t("statusFailed")));
    } finally {
      setPending(null);
    }
  }

  async function importFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    setImportState({ kind: "running" });
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({
          // A folder upload carries the relative path; a plain pick only the name.
          path: file.webkitRelativePath || file.name,
          content: await file.text(),
        })),
      );
      const result = await importBlogMarkdown(payload);
      setImportState({ kind: "done", result });
      await load();
    } catch (caught) {
      setImportState({
        kind: "failed",
        message: errorMessage(caught, t("import.failed")),
        problems: importProblems(caught) ?? [],
      });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Newspaper className="size-4" />
          {t("eyebrow")}
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("heading")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              aria-label={t("refresh")}
              onClick={() => void load()}
              size="icon"
              variant="outline"
            >
              <RefreshCw className="size-4" />
            </Button>
            <input
              accept=".md,text/markdown"
              className="sr-only"
              data-testid="blog-import-input"
              multiple
              onChange={(event) => void importFiles(event.target.files)}
              ref={fileInput}
              type="file"
            />
            <Button
              disabled={importState.kind === "running"}
              onClick={() => fileInput.current?.click()}
            >
              {importState.kind === "running" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("import.button")}
            </Button>
          </div>
        </div>

        {importState.kind === "done" ? (
          <div className="mt-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm" role="status">
            <p className="font-medium">
              {t("import.done", {
                count: importState.result.posts.length,
                created: importState.result.posts.filter((post) => post.created).length,
                updated: importState.result.posts.filter((post) => !post.created).length,
              })}
            </p>
            <p className="mt-1 text-muted-foreground">{t("import.doneHint")}</p>
          </div>
        ) : null}
        {importState.kind === "failed" ? (
          <div
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
            role="alert"
          >
            <p className="font-medium text-destructive">
              {importState.problems.length > 0 ? t("import.refused") : importState.message}
            </p>
            {importState.problems.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {importState.problems.map((problem, index) => (
                  <li key={`${problem.path}-${index}`}>
                    {problem.path ? <span className="font-mono text-xs">{problem.path}</span> : null}
                    <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">
                      {problem.message}
                    </pre>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input
              aria-label={t("search")}
              className="h-8 pl-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              value={query}
            />
          </div>
          <select
            aria-label={t("statusFilter")}
            className={selectClass}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            value={status}
          >
            {FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(`filter.${value}`)}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          {posts === null ? (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {groups.length === 0 ? t("empty") : t("noMatches")}
            </p>
          ) : (
            <ul>
              {visible.map((group) => {
                const active = group.articleId === selectedGroup?.articleId;
                return (
                  <li className="border-b border-border last:border-b-0" key={group.articleId}>
                    <button
                      aria-pressed={active}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                        active && "bg-muted",
                      )}
                      onClick={() => setSelectedId(active ? null : group.versions[0]!.id)}
                      type="button"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{group.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {group.articleId}
                          {group.category ? ` · ${group.category}` : ""}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {group.versions.map((post) => (
                          <Badge key={post.id} variant={VISIBILITY_VARIANT[visibilityOf(post)]}>
                            {post.locale} · {t(`visibility.${visibilityOf(post)}`)}
                          </Badge>
                        ))}
                      </span>
                      <span className="w-full text-xs text-muted-foreground sm:w-auto">
                        {formatDate(group.syncedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selectedGroup && selectedPost ? (
          <section
            aria-label={t("detail.label")}
            className="mt-6 rounded-lg border border-border"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="flex flex-wrap gap-1" role="tablist">
                {selectedGroup.versions.map((post) => (
                  <Button
                    aria-selected={post.id === selectedPost.id}
                    key={post.id}
                    onClick={() => setSelectedId(post.id)}
                    role="tab"
                    size="sm"
                    variant={post.id === selectedPost.id ? "secondary" : "ghost"}
                  >
                    {post.locale}
                  </Button>
                ))}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {visibilityOf(selectedPost) === "published" ? (
                  <Button asChild size="sm" variant="ghost">
                    <a href={blogPostPublicPath(selectedPost)} rel="noreferrer" target="_blank">
                      <ExternalLink className="size-4" />
                      {t("detail.viewLive")}
                    </a>
                  </Button>
                ) : null}
                {visibilityOf(selectedPost) === "published" ? (
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
                {selectedPost.status !== "archived" ? (
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

            <dl className="grid gap-x-6 gap-y-2 border-b border-border px-4 py-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{t("detail.status")}</dt>
              <dd>
                <Badge variant={VISIBILITY_VARIANT[visibilityOf(selectedPost)]}>
                  {t(`visibility.${visibilityOf(selectedPost)}`)}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">{t("detail.address")}</dt>
              <dd className="break-all font-mono text-xs">{blogPostPublicPath(selectedPost)}</dd>
              <dt className="text-muted-foreground">{t("detail.published")}</dt>
              <dd>{formatDate(selectedPost.publishedAt)}</dd>
              <dt className="text-muted-foreground">{t("detail.imported")}</dt>
              <dd>{formatDate(selectedPost.syncedAt)}</dd>
              <dt className="text-muted-foreground">{t("detail.source")}</dt>
              <dd>{t(`source.${selectedPost.source}`)}</dd>
              <dt className="text-muted-foreground">{t("detail.readingTime")}</dt>
              <dd>{t("detail.minutes", { count: selectedPost.readingTimeMinutes })}</dd>
              <dt className="text-muted-foreground">{t("detail.excerpt")}</dt>
              <dd>{selectedPost.excerpt}</dd>
            </dl>

            {detailError ? (
              <p className="px-4 py-3 text-sm text-destructive" role="alert">
                {detailError}
              </p>
            ) : null}

            <div className="px-4 py-6">
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
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
