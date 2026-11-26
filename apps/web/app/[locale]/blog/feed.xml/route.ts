import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";

import { routing } from "../../../../i18n/routing";
import { listPublishedBlogPostsInLocale } from "../../../../lib/blog-db";
import { BLOG_FEED_CONTENT_TYPE, blogFeedXml } from "../../../../lib/blog-feed";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string }> },
) {
  const { locale } = await context.params;
  if (!hasLocale(routing.locales, locale)) {
    return new Response("Feed not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const [t, posts] = await Promise.all([
      getTranslations({ locale, namespace: "blog.meta" }),
      listPublishedBlogPostsInLocale(locale),
    ]);
    return new Response(
      blogFeedXml({
        locale,
        title: t("ogTitle"),
        description: t("description"),
        posts,
      }),
      {
        headers: {
          "Content-Type": `${BLOG_FEED_CONTENT_TYPE}; charset=utf-8`,
          "Cache-Control": "public, max-age=300, s-maxage=300",
        },
      },
    );
  } catch (error) {
    // Never serve a partial or empty feed for a failed read: a reader would
    // take it as "every article was removed".
    console.error("Blog feed generation failed", error);
    return new Response("Feed temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
