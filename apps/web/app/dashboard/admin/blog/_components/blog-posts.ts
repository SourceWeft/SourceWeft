import type { BlogAdminPost } from "@sourceweft/contracts";

/** What a reader can see: `hidden` is a published row with sync turned off. */
export type BlogPostVisibility = "published" | "draft" | "archived" | "hidden";
export type BlogStatusFilter = "all" | BlogPostVisibility;

export const BLOG_STATUS_FILTERS: BlogStatusFilter[] = [
  "all",
  "published",
  "draft",
  "archived",
  "hidden",
];

export const BLOG_ADMIN_HREF = "/dashboard/admin/blog";

const LOCALE_ORDER = ["en", "zh-CN", "zh-TW"];

export const VISIBILITY_VARIANT: Record<
  BlogPostVisibility,
  "default" | "secondary" | "outline" | "destructive"
> = {
  published: "default",
  draft: "secondary",
  archived: "outline",
  hidden: "destructive",
};

export function visibilityOf(
  post: Pick<BlogAdminPost, "status" | "syncEnabled">,
): BlogPostVisibility {
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
  status: BlogStatusFilter,
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

/** The admin page of an article, optionally opened on one language version. */
export function blogArticleAdminHref(articleId: string, locale?: string) {
  const path = `${BLOG_ADMIN_HREF}/${encodeURIComponent(articleId)}`;
  return locale ? `${path}?locale=${encodeURIComponent(locale)}` : path;
}
