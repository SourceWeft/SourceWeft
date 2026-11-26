import type { Metadata } from "next";
import Link from "next/link";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "../../../../i18n/routing";
import { buildAlternates } from "../../../../lib/i18n/metadata";
import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import { marketingContainerClassName } from "../../../_landing/components/marketing-container";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import { OG_IMAGE, SITE_NAME } from "../../../seo";
import { BlogGuidesSection } from "../../blog/_components/blog-link-sections";
import { METHOD_PATH, METHOD_SECTIONS } from "./method-path";

const SUPPORT_EMAIL = "support@sourceweft.com";
const REPOSITORY_URL = "https://github.com/SourceWeft/SourceWeft";

/**
 * The score table. Keys, points and "required when" mirror `MCP_SCORE_RULES`
 * in `apps/backend/src/modules/market/score/score.ts`; the check names are the
 * ones the score card on a server page uses (`mcp.score.items`). Change both
 * together.
 */
const SCORE_ROWS = [
  { key: "reachable", points: 25, required: "remote" },
  { key: "authDeclared", points: 10, required: "remote" },
  { key: "hasTools", points: 15, required: "tools" },
  { key: "hasDescription", points: 15, required: "always" },
  { key: "hasLogo", points: 10, required: "never" },
  { key: "hasDocs", points: 15, required: "never" },
  { key: "hasLicense", points: 10, required: "never" },
] as const;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/about/method">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "method.meta" });
  const alternates = buildAlternates(METHOD_PATH, locale);
  const title = t("title");
  const description = t("description");
  return {
    title,
    description,
    alternates,
    openGraph: {
      description,
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title,
      type: "website",
      url: alternates.canonical,
    },
    twitter: {
      card: "summary_large_image",
      description,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

const headingClassName =
  "scroll-mt-28 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white";
const subheadingClassName =
  "mt-8 text-base font-semibold text-zinc-950 dark:text-white";
const bodyClassName =
  "mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300";
const linkClassName =
  "underline underline-offset-4 transition-colors hover:text-zinc-950 dark:hover:text-white";

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 list-disc space-y-2 pl-5 text-base leading-7 text-zinc-600 dark:text-zinc-300">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default async function MethodPage({
  params,
}: PageProps<"/[locale]/about/method">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const [t, tScore, authState] = await Promise.all([
    getTranslations("method"),
    getTranslations("mcp.score"),
    resolveInitialLandingAuthState(),
  ]);
  const list = (key: string) => t.raw(key) as string[];

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <SourceWeftHeader authState={authState} />

      <section className="border-b border-zinc-300 dark:border-white/10">
        <div
          className={`mx-auto pb-12 pt-28 lg:pb-14 lg:pt-32 ${marketingContainerClassName}`}
        >
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {t("hero.eyebrow")}
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              {t("hero.heading")}
            </h1>
            <p className="mt-6 text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {t("hero.intro")}
            </p>
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
              {t("hero.updated")}
            </p>
          </div>
        </div>
      </section>

      <div
        className={`mx-auto grid gap-10 py-12 lg:grid-cols-[14rem_minmax(0,1fr)] lg:py-16 ${marketingContainerClassName}`}
      >
        <nav aria-label={t("contents")} className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {t("contents")}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {METHOD_SECTIONS.map((section) => (
              <li key={section}>
                <a
                  href={`#${section}`}
                  className="text-zinc-600 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
                >
                  {t(`${section}.title`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 max-w-3xl space-y-14">
          <section>
            <h2 className={headingClassName} id="sources">
              {t("sources.title")}
            </h2>
            <h3 className={subheadingClassName}>{t("sources.mcpTitle")}</h3>
            <Points items={list("sources.mcp")} />
            <h3 className={subheadingClassName}>{t("sources.skillsTitle")}</h3>
            <Points items={list("sources.skills")} />
          </section>

          <section>
            <h2 className={headingClassName} id="overviews">
              {t("overviews.title")}
            </h2>
            <p className={bodyClassName}>{t("overviews.intro")}</p>
            <Points items={list("overviews.items")} />
          </section>

          <section>
            <h2 className={headingClassName} id="score">
              {t("score.title")}
            </h2>
            <p className={bodyClassName}>{t("score.intro")}</p>
            <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-300 bg-white/58 dark:border-white/10 dark:bg-white/[0.03]">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      {t("score.columns.check")}
                    </th>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      {t("score.columns.points")}
                    </th>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      {t("score.columns.required")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-white/10 dark:border-white/10">
                  {SCORE_ROWS.map((row) => (
                    <tr key={row.key}>
                      <th className="px-4 py-3 font-medium" scope="row">
                        {tScore(`items.${row.key}.label`)}
                      </th>
                      <td className="px-4 py-3 tabular-nums">{row.points}</td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {t(`score.requiredWhen.${row.required}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Points items={list("score.notes")} />
          </section>

          <section>
            <h2 className={headingClassName} id="scan">
              {t("scan.title")}
            </h2>
            <p className={bodyClassName}>{t("scan.intro")}</p>
            <Points items={list("scan.items")} />
          </section>

          <section>
            <h2 className={headingClassName} id="publishers">
              {t("publishers.title")}
            </h2>
            <p className={bodyClassName}>{t("publishers.intro")}</p>
            <h3 className={subheadingClassName}>{t("publishers.mcpTitle")}</h3>
            <Points items={list("publishers.mcp")} />
            <h3 className={subheadingClassName}>
              {t("publishers.skillsTitle")}
            </h3>
            <Points items={list("publishers.skills")} />
          </section>

          <section>
            <h2 className={headingClassName} id="reports">
              {t("reports.title")}
            </h2>
            <Points items={list("reports.items")} />
          </section>

          <section>
            <h2 className={headingClassName} id="responsibility">
              {t("responsibility.title")}
            </h2>
            <p className={bodyClassName}>{t("responsibility.body")}</p>
            <dl className="mt-6 space-y-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">
              <div>
                <dt className="font-semibold text-zinc-950 dark:text-white">
                  {t("responsibility.contactLabel")}
                </dt>
                <dd>
                  <a className={linkClassName} href={`mailto:${SUPPORT_EMAIL}`}>
                    {SUPPORT_EMAIL}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-950 dark:text-white">
                  {t("responsibility.sourceLabel")}
                </dt>
                <dd>
                  {t("responsibility.sourceBody")}{" "}
                  <a
                    className={linkClassName}
                    href={REPOSITORY_URL}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    github.com/SourceWeft/SourceWeft
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-950 dark:text-white">
                  {t("responsibility.legalLabel")}
                </dt>
                <dd className="flex gap-4">
                  <Link className={linkClassName} href="/terms">
                    {t("responsibility.terms")}
                  </Link>
                  <Link className={linkClassName} href="/privacy">
                    {t("responsibility.privacy")}
                  </Link>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      <BlogGuidesSection directory="method" />

      <SourceWeftFooter authState={authState} />
    </main>
  );
}
