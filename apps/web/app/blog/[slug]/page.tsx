import {
  BlogArticlePageContent,
  generateBlogArticleMetadata,
} from "../article-page";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return generateBlogArticleMetadata({ slug });
}

export default async function BlogArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <BlogArticlePageContent slug={slug} />;
}
