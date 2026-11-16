import { AdminPage } from "../../_components/admin-page";
import { BlogArticle } from "../_components/blog-article";

export default async function BlogArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ articleId: string }>;
  searchParams: Promise<{ locale?: string | string[] }>;
}) {
  const [{ articleId }, { locale }] = await Promise.all([params, searchParams]);
  return (
    <AdminPage>
      <BlogArticle
        articleId={decodeURIComponent(articleId)}
        initialLocale={typeof locale === "string" ? locale : undefined}
      />
    </AdminPage>
  );
}
