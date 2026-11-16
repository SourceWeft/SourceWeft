"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Search, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { BlogAdminPost, ImportBlogMarkdownResponse } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sourceweft/ui-web/components/ui/table";

import {
  importBlogMarkdown,
  importProblems,
  listBlogAdminPosts,
} from "../../../../../lib/blog-admin";
import { errorMessage } from "../../../../../lib/skill-market-audit";
import {
  BLOG_STATUS_FILTERS,
  VISIBILITY_VARIANT,
  blogArticleAdminHref,
  filterBlogGroups,
  groupBlogPosts,
  visibilityOf,
  type BlogStatusFilter,
} from "./blog-posts";

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground";

type ImportState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: ImportBlogMarkdownResponse }
  | { kind: "failed"; message: string; problems: Array<{ path: string; message: string }> };

/** Every article as one table row; a row opens the article's own page. */
export function BlogAdmin() {
  const t = useTranslations("dashboardBlogAdmin");
  const locale = useLocale();
  const [posts, setPosts] = React.useState<BlogAdminPost[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<BlogStatusFilter>("all");
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

  const groups = React.useMemo(() => groupBlogPosts(posts ?? []), [posts]);
  const visible = React.useMemo(
    () => filterBlogGroups(groups, query, status),
    [groups, query, status],
  );

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );

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
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
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
          onChange={(event) => setStatus(event.target.value as BlogStatusFilter)}
          value={status}
        >
          {BLOG_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(`filter.${value}`)}
            </option>
          ))}
        </select>
        {posts !== null && groups.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("count", { shown: visible.length, total: groups.length })}
          </span>
        ) : null}
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
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4">{t("columns.article")}</TableHead>
                <TableHead>{t("columns.category")}</TableHead>
                <TableHead>{t("columns.languages")}</TableHead>
                <TableHead className="px-4 text-right">{t("columns.imported")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((group) => (
                <TableRow key={group.articleId}>
                  <TableCell className="max-w-0 w-1/2 px-4 py-3">
                    <Link
                      className="block truncate font-medium hover:underline"
                      href={blogArticleAdminHref(group.articleId)}
                    >
                      {group.title}
                    </Link>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {group.articleId}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{group.category ?? "—"}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {group.versions.map((post) => (
                        <Badge asChild key={post.id} variant={VISIBILITY_VARIANT[visibilityOf(post)]}>
                          <Link href={blogArticleAdminHref(group.articleId, post.locale)}>
                            {post.locale} · {t(`visibility.${visibilityOf(post)}`)}
                          </Link>
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 text-right text-xs text-muted-foreground">
                    {formatDate(group.syncedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
