import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type {
  GetMarketSkillResponse,
  MarketSkillSummary,
} from "@sourceweft/market-sdk";
import { hasLocale, useLocale, useTranslations } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { formatNumber } from "@sourceweft/i18n/format";
import { DEFAULT_LOCALE, isLocale } from "@sourceweft/i18n/locales";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { routing } from "../../../../i18n/routing";
import { JsonLd } from "../../../_components/seo/json-ld";
import { resolveInitialLandingAuthState } from "../../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../../_landing/components/sourceweft-header";
import { CopyButton } from "../../mcp/_components/mcp-client";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../../../seo";
import {
  getPublicSkill,
  isMarketNotFound,
  listPublicSkillCategories,
  marketSkillLocale,
} from "../../../../lib/market-skills";
import { getPublicSkillReviews } from "../../../../lib/public-skill-reviews";
import { skillAggregateRatingJsonLd } from "../_components/community/public-reviews-format";
import { PublicSkillOverview } from "../_components/community/public-skill-overview";
import { PublicSkillReport } from "../_components/community/public-skill-report";
import { PublicSkillReviews } from "../_components/community/public-skill-reviews";
import { PublicSkillRunStats } from "../_components/community/public-skill-run-stats";
import { SkillMarkdown } from "../_components/skill-markdown";
import {
  SkillArchivedBadge,
  SkillCapabilityBadge,
  SkillCardGrid,
  skillCategoryNames,
  SkillClaimedBadge,
  SkillExternalLink,
  SkillFeaturedBadge,
  SkillVerifiedBadge,
} from "../_components/skills-display";
import { SkillTile } from "../_components/skill-logo";
import {
  commitUrl,
  formatCompactCount,
  formatFileSize,
  formatRelativeTime,
  githubRepository,
  formatSkillDate,
  formatSkillVersion,
  parseSkillDetailTab,
  repoLabel,
  safeExternalUrl,
  scanFlagLabel,
  shortCommitSha,
  shortSeoText,
  skillCategoryLabel,
  skillCategoryPath,
  skillClaimHref,
  skillCliInstallCommand,
  skillInstallHref,
  skillPath,
  skillsContainerClassName,
  skillTabHref,
  skillTakedownMailto,
  stripSkillFrontmatter,
  type SkillDetailTab,
  skillLocalInstallCommand,
} from "../_components/skills-format";

// Not build-time prerendered: canonical/JSON-LD embed the public site URL, which
// is injected at container start, so a build-time render would bake in the
// wrong origin. Freshness comes from the cached market reads (60s).
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// `locale` is for the page body (AI summaries in the related lists); the
// metadata reads the author's own description and needs none.
async function loadSkill(slug: string, locale?: string) {
  try {
    return await getPublicSkill(
      slug,
      locale ? marketSkillLocale(locale) : undefined,
    );
  } catch (error) {
    // Not public, withdrawn, or never existed: all one 404. A market outage
    // must surface as 5xx instead — a 404 would deindex every skill page.
    if (isMarketNotFound(error)) {
      notFound();
    }
    throw error;
  }
}

const panelClassName =
  "rounded-xl border border-zinc-300 bg-white/58 p-5 dark:border-white/10 dark:bg-white/[0.03]";

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const [{ locale, slug }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "publicSkills.detail" });
  try {
    const { skill } = await loadSkill(decodeURIComponent(slug));
    const title = t("metaTitle", { name: skill.displayName });
    const description = shortSeoText(
      t("metaDescription", {
        description: skill.description,
        name: skill.displayName,
      }),
    );
    const url = `${SITE_URL}${skillPath(skill.slug)}`;
    return {
      alternates: { canonical: url },
      description,
      openGraph: {
        description,
        images: [OG_IMAGE],
        siteName: SITE_NAME,
        title,
        type: "article",
        url,
      },
      // The Files / Versions / Install tabs are views of the same page.
      ...(parseSkillDetailTab(rawSearchParams.tab) === "skill"
        ? {}
        : NO_INDEX_METADATA),
      title,
      twitter: {
        card: "summary_large_image",
        description,
        images: [OG_IMAGE.url],
        title,
      },
    };
  } catch {
    return { title: t("fallbackMetaTitle") };
  }
}

/** A copyable shell command, as the install tab shows each one. */
function CommandLine({ command }: { command: string }) {
  const t = useTranslations("publicSkills.detail.install");
  return (
    <div className="mt-3 flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs leading-5 text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
        {command}
      </code>
      <CopyButton
        className="h-8 shrink-0 px-2"
        label={t("copy")}
        value={command}
      />
    </div>
  );
}

/** "3 files changed · 1 new script" and the compare link, for one version. */
function VersionChanges({
  changes,
}: {
  changes: NonNullable<GetMarketSkillResponse["versions"][number]["changes"]>;
}) {
  const t = useTranslations("publicSkills");
  const files =
    changes.added.length + changes.removed.length + changes.modified.length;
  const compareUrl = safeExternalUrl(changes.compareUrl);
  return (
    <div className="mt-1.5 w-full space-y-1 text-xs text-zinc-500">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {files > 0
            ? [
                changes.added.length
                  ? t("detail.versions.added", {
                      count: changes.added.length,
                    })
                  : null,
                changes.modified.length
                  ? t("detail.versions.modified", {
                      count: changes.modified.length,
                    })
                  : null,
                changes.removed.length
                  ? t("detail.versions.removed", {
                      count: changes.removed.length,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : t("detail.versions.noChanges")}
        </span>
        {compareUrl ? (
          <SkillExternalLink className="text-xs" href={compareUrl}>
            {t("detail.versions.compare")}
          </SkillExternalLink>
        ) : null}
      </p>
      {changes.newScripts.length > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          {t("detail.versions.newScripts", {
            paths: changes.newScripts.join(", "),
          })}
        </p>
      ) : null}
      {changes.newFlags.length > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          {t("detail.versions.newFlags", {
            flags: changes.newFlags
              .map((flag) =>
                scanFlagLabel(
                  flag,
                  t.raw("scanFlags") as Record<string, string>,
                ),
              )
              .join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}

function InstallCta({
  className,
  installHref,
  skill,
}: {
  className?: string;
  installHref: string;
  skill: MarketSkillSummary;
}) {
  const t = useTranslations("publicSkills.detail.install");
  const chatPrompt = t("chatPrompt", { slug: skill.slug });
  return (
    <div className={className}>
      <Link
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
        href={installHref}
        prefetch={false}
        rel="nofollow"
      >
        {t("cta")}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{t("chatLead")}</span>
        <code className="min-w-0 break-all rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
          {chatPrompt}
        </code>
        <CopyButton className="h-6 px-2" label={t("copy")} value={chatPrompt} />
      </div>
    </div>
  );
}

function FilesTab({ files }: { files: GetMarketSkillResponse["files"] }) {
  const t = useTranslations("publicSkills.detail.files");
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {t("note")}
      </p>
      {files.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-300 bg-white/58 dark:border-white/10 dark:bg-white/[0.03]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-white/10">
              <tr>
                <th className="px-5 py-3 font-medium" scope="col">
                  {t("path")}
                </th>
                <th className="px-5 py-3 text-right font-medium" scope="col">
                  {t("size")}
                </th>
                <th className="px-5 py-3 font-medium" scope="col">
                  {t("type")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-white/10">
              {files.map((file) => (
                <tr key={file.path}>
                  <td className="break-all px-5 py-3 font-mono text-xs">
                    {file.path}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {formatFileSize(file.sizeBytes)}
                  </td>
                  <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">
                    {file.mimeType ?? t("unknownType")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={`${panelClassName} text-sm text-zinc-500`}>
          {t("empty")}
        </p>
      )}
    </div>
  );
}

function VersionsTab({
  repoUrl,
  versions,
}: {
  repoUrl: string | null;
  versions: GetMarketSkillResponse["versions"];
}) {
  const t = useTranslations("publicSkills.detail.versions");
  const locale = useLocale();
  if (versions.length === 0) {
    return (
      <p className={`${panelClassName} text-sm text-zinc-500`}>{t("empty")}</p>
    );
  }
  return (
    <ol className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {versions.map((entry) => {
        const published = formatSkillDate(entry.publishedAt, locale);
        const sha = shortCommitSha(entry.commitSha);
        const shaHref = commitUrl(repoUrl, entry.commitSha);
        return (
          <li
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm"
            key={entry.version}
          >
            <span className="font-mono font-medium">
              {formatSkillVersion(entry.version)}
              {entry.isCurrent ? (
                <span className="ml-2 rounded-full bg-zinc-950 px-2 py-0.5 font-sans text-[11px] text-white dark:bg-white dark:text-zinc-950">
                  {t("current")}
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 text-zinc-500">
              {sha ? (
                <span className="inline-flex items-center gap-1.5">
                  {t("commit")}{" "}
                  {shaHref ? (
                    <SkillExternalLink
                      className="font-mono text-xs"
                      href={shaHref}
                    >
                      {sha}
                    </SkillExternalLink>
                  ) : (
                    <span className="font-mono text-xs">{sha}</span>
                  )}
                </span>
              ) : null}
              <span>
                {published
                  ? t("published", { date: published })
                  : t("unpublishedDate")}
              </span>
            </span>
            {entry.changes ? <VersionChanges changes={entry.changes} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export default async function PublicSkillDetailPage({
  params,
  searchParams,
}: PageProps) {
  const [{ locale, slug }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("publicSkills");
  const uiLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const decodedSlug = decodeURIComponent(slug);
  const tab = parseSkillDetailTab(rawSearchParams.tab);
  const [authState, result, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadSkill(decodedSlug, uiLocale),
    listPublicSkillCategories(),
  ]);
  const { files, scanFlags, skill, source, versions } = result;
  // Cached with the reviews section's own read, so this costs nothing extra.
  const reviews = await getPublicSkillReviews(skill.slug);
  const related = result.related ?? { sameRepository: [], sameCategory: [] };
  const categoryNames = skillCategoryNames(categoriesResponse.items);
  const skillMd = stripSkillFrontmatter(result.skillMd);
  const installHref = skillInstallHref(skill.slug, authState.isSignedIn);

  const repoUrl = safeExternalUrl(source.repoUrl ?? skill.repoUrl);
  const sourceUrl = safeExternalUrl(source.sourceUrl ?? skill.sourceUrl);
  const commitSha = shortCommitSha(source.commitSha);
  const commitHref = commitUrl(repoUrl, source.commitSha) ?? sourceUrl;
  const localInstallCommand = skillLocalInstallCommand(source);
  // Only when the CLI would install it: it refuses a name it cannot use as a
  // directory.
  const cliInstallCommand =
    skill.cliInstallable === false ? null : skillCliInstallCommand(skill.slug);
  const repository = githubRepository(repoUrl);
  // The author's way in, for a repository nobody has claimed yet.
  const claimHref = skill.claimed ? null : skillClaimHref(repoUrl);
  const stars = skill.stars ?? 0;
  const pushed = formatRelativeTime(skill.repoPushedAt, undefined, uiLocale);
  const license = skill.license ?? t("detail.noLicense");
  const listed = formatSkillDate(skill.listedAt, uiLocale);
  const updated = formatSkillDate(skill.updatedAt, uiLocale);
  const scanFlagLabels = t.raw("scanFlags") as Record<string, string>;
  const primaryCategory = skill.categories[0];
  const pageUrl = `${SITE_URL}${skillPath(skill.slug)}`;

  const tabs: [SkillDetailTab, string][] = [
    ["skill", t("detail.tabs.skill")],
    ["files", t("detail.tabs.files", { count: files.length })],
    ["versions", t("detail.tabs.versions", { count: versions.length })],
    ["install", t("detail.tabs.install")],
  ];
  const facts: [string, string][] = [
    [t("detail.facts.version"), formatSkillVersion(skill.version)],
    [t("detail.facts.license"), license],
    ...(skill.installCount > 0
      ? ([
          [
            t("detail.facts.workspaces"),
            formatCompactCount(skill.installCount),
          ],
        ] as [string, string][])
      : []),
    ...(stars > 0
      ? ([[t("detail.facts.stars"), formatCompactCount(stars)]] as [
          string,
          string,
        ][])
      : []),
    [t("detail.facts.files"), formatNumber(files.length, uiLocale)],
  ];
  const details: [string, string][] = [
    [t("detail.details.slug"), skill.slug],
    [t("detail.details.name"), skill.name],
    ...(skill.author
      ? ([[t("detail.details.author"), skill.author]] as [string, string][])
      : []),
    ...(skill.capability
      ? ([
          [
            t("detail.details.type"),
            skill.capability === "executable"
              ? t("badges.executable")
              : t("badges.promptOnly"),
          ],
        ] as [string, string][])
      : []),
    [
      t("detail.details.trust"),
      skill.featured && skill.verified
        ? t("detail.details.featuredAndVerified")
        : skill.featured
          ? t("badges.featured")
          : skill.verified
            ? t("badges.verified")
            : t("detail.details.unverified"),
    ],
    ...(listed
      ? ([[t("detail.details.listed"), listed]] as [string, string][])
      : []),
    ...(updated
      ? ([[t("detail.details.updated"), updated]] as [string, string][])
      : []),
  ];

  const sourceCodeJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    ...(skill.author
      ? { author: { "@type": "Organization", name: skill.author } }
      : {}),
    ...(repoUrl ? { codeRepository: repoUrl } : {}),
    ...(skill.updatedAt ? { dateModified: skill.updatedAt } : {}),
    datePublished: skill.listedAt,
    description: skill.description,
    ...(skill.license ? { license: skill.license } : {}),
    // Only once someone has rated it.
    ...skillAggregateRatingJsonLd(reviews?.summary),
    name: skill.displayName,
    url: pageUrl,
    version: skill.version,
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: SITE_URL,
        name: t("breadcrumb.home"),
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/skills`,
        name: t("breadcrumb.skills"),
        position: 2,
      },
      {
        "@type": "ListItem",
        item: pageUrl,
        name: skill.displayName,
        position: 3,
      },
    ],
  };

  return (
    <main className="min-h-svh bg-[#f7f4ed] text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <JsonLd data={sourceCodeJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <SourceWeftHeader
        authState={authState}
        containerClassName={skillsContainerClassName}
      />

      <section className="relative overflow-hidden border-b border-zinc-300 dark:border-white/10">
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:42px_42px] dark:bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)]"
        />
        <div
          className={`relative mx-auto pb-8 pt-24 ${skillsContainerClassName}`}
        >
          <nav
            aria-label={t("breadcrumb.label")}
            className="mb-8 flex min-w-0 items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400"
          >
            <Link
              className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
              href="/skills"
            >
              {t("breadcrumb.skills")}
            </Link>
            {primaryCategory ? (
              <>
                <ChevronRight className="size-3.5 shrink-0" />
                <Link
                  className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
                  href={skillCategoryPath(primaryCategory)}
                >
                  {skillCategoryLabel(primaryCategory, categoryNames)}
                </Link>
              </>
            ) : null}
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="truncate text-zinc-950 dark:text-white">
              {skill.slug}
            </span>
          </nav>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="min-w-0">
              <div className="flex items-start gap-4">
                <SkillTile
                  logo={skill.logo}
                  size="lg"
                  verified={skill.verified}
                />
                <div className="min-w-0">
                  <h1 className="break-words text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                    {skill.displayName}
                  </h1>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {skill.author ? (
                      <span>
                        {t("detail.by")}{" "}
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {skill.author}
                        </span>
                      </span>
                    ) : null}
                    <span>{formatSkillVersion(skill.version)}</span>
                    <span>{license}</span>
                    {skill.installCount > 0 ? (
                      <span>
                        {t("detail.workspaces", {
                          compact: formatCompactCount(skill.installCount),
                          count: skill.installCount,
                        })}
                      </span>
                    ) : null}
                    {stars > 0 ? (
                      <span>
                        {t("detail.stars", {
                          count: formatCompactCount(stars),
                        })}
                      </span>
                    ) : null}
                    {listed ? (
                      <span>{t("detail.listed", { date: listed })}</span>
                    ) : null}
                    {updated ? (
                      <span>{t("detail.updated", { date: updated })}</span>
                    ) : null}
                    {pushed ? (
                      <span>
                        {t("detail.repoPushed", { relative: pushed })}
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                {skill.description}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {skill.featured ? <SkillFeaturedBadge /> : null}
                {skill.verified ? <SkillVerifiedBadge /> : null}
                {skill.claimed ? <SkillClaimedBadge /> : null}
                {skill.repoArchived ? <SkillArchivedBadge /> : null}
                <SkillCapabilityBadge capability={skill.capability} />
                {skill.categories.map((category) => (
                  <Link
                    className="inline-flex h-6 items-center rounded-full border border-zinc-300 bg-white/70 px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:border-white/40 dark:hover:text-white"
                    href={skillCategoryPath(category)}
                    key={category}
                  >
                    {skillCategoryLabel(category, categoryNames)}
                  </Link>
                ))}
              </div>
            </div>

            <aside className="rounded-xl border border-zinc-300 bg-white/70 p-5 dark:border-white/10 dark:bg-white/[0.04]">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {facts.map(([label, value]) => (
                  <div className="min-w-0" key={label}>
                    <dt className="text-xs text-zinc-500">{label}</dt>
                    <dd className="mt-1 truncate font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <InstallCta
                className="mt-5"
                installHref={installHref}
                skill={skill}
              />
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {repoUrl ? (
                  <SkillExternalLink href={repoUrl}>
                    {t("detail.repository")}
                  </SkillExternalLink>
                ) : null}
                {sourceUrl ? (
                  <SkillExternalLink href={sourceUrl}>
                    {t("detail.source")}
                  </SkillExternalLink>
                ) : null}
              </div>
              {claimHref ? (
                <p className="mt-4 border-t border-zinc-200 pt-3 text-xs dark:border-white/10">
                  <Link
                    className="text-zinc-500 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 hover:decoration-zinc-950 dark:decoration-white/20 dark:hover:text-white"
                    href={claimHref}
                    prefetch={false}
                    rel="nofollow"
                  >
                    {t("detail.claimLink")}
                  </Link>
                </p>
              ) : null}
            </aside>
          </div>
        </div>
      </section>

      <nav
        aria-label={t("detail.tabsLabel")}
        className="sticky top-14 z-40 border-b border-zinc-300 bg-[#f7f4ed]/90 backdrop-blur-[12px] dark:border-white/10 dark:bg-zinc-950/90"
      >
        <div
          className={`mx-auto flex gap-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${skillsContainerClassName}`}
        >
          {tabs.map(([id, label]) => (
            <Link
              aria-current={tab === id ? "page" : undefined}
              className={cn(
                "shrink-0 border-b-2 py-3 text-sm transition-colors",
                tab === id
                  ? "border-zinc-950 font-medium text-zinc-950 dark:border-white dark:text-white"
                  : "border-transparent text-zinc-500 hover:border-zinc-950 hover:text-zinc-950 dark:hover:border-white dark:hover:text-white",
              )}
              href={skillTabHref(skill.slug, id)}
              key={id}
              scroll={false}
            >
              {label}
            </Link>
          ))}
        </div>
      </nav>

      <div
        className={`mx-auto grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_320px] ${skillsContainerClassName}`}
      >
        <div className="min-w-0">
          {tab === "skill" ? (
            <PublicSkillOverview
              locale={uiLocale}
              signedIn={authState.isSignedIn}
              slug={skill.slug}
            />
          ) : null}
          {tab === "skill" ? (
            skillMd ? (
              <article className={`${panelClassName} min-w-0 sm:p-7`}>
                <SkillMarkdown imagePlaceholder={t("detail.imagePlaceholder")}>
                  {skillMd}
                </SkillMarkdown>
              </article>
            ) : (
              <p className={`${panelClassName} text-sm text-zinc-500`}>
                {t("detail.skillMdMissing")}
              </p>
            )
          ) : null}

          {tab === "files" ? <FilesTab files={files} /> : null}

          {tab === "versions" ? (
            <VersionsTab repoUrl={repoUrl} versions={versions} />
          ) : null}

          {tab === "install" ? (
            <div className={panelClassName}>
              <h2 className="text-lg font-semibold">
                {t("detail.install.heading")}
              </h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {(t.raw("detail.install.steps") as string[]).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {skill.capability ? (
                <p className="mt-4 rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                  {skill.capability === "executable"
                    ? t("detail.install.executableNote")
                    : t("detail.install.promptOnlyNote")}
                </p>
              ) : null}
              <InstallCta
                className="mt-5 max-w-sm"
                installHref={installHref}
                skill={skill}
              />
              {authState.isSignedIn ? null : (
                <p className="mt-3 text-xs text-zinc-500">
                  {t("detail.install.signedOutNote")}
                </p>
              )}
              {cliInstallCommand ? (
                <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-white/10">
                  <h3 className="text-base font-semibold">
                    {t("detail.install.cli.heading")}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {t("detail.install.cli.lead")}
                  </p>
                  <CommandLine command={cliInstallCommand} />
                  <p className="mt-2 text-xs leading-5 text-zinc-500">
                    {t("detail.install.cli.agentHint")}
                  </p>
                  {skill.capability === "executable" ? (
                    <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
                      {t("detail.install.cli.executableNote")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {localInstallCommand ? (
                <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-white/10">
                  <h3 className="text-base font-semibold">
                    {t("detail.install.upstream.heading")}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {t("detail.install.upstream.lead")}
                  </p>
                  <CommandLine command={localInstallCommand} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-32 lg:self-start">
          <section className={panelClassName}>
            <h2 className="mb-4 text-base font-semibold">
              {t("detail.details.heading")}
            </h2>
            <dl className="space-y-3 text-sm">
              {details.map(([label, value]) => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-zinc-200 pb-3 last:border-0 last:pb-0 dark:border-white/10"
                  key={label}
                >
                  <dt className="shrink-0 text-zinc-500">{label}</dt>
                  <dd className="min-w-0 break-all text-right font-medium">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {scanFlags.length > 0 ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-4" />
                {t("detail.scan.heading")}
              </div>
              <p>{t("detail.scan.body")}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                {scanFlags.map((flag) => (
                  <li key={flag}>{scanFlagLabel(flag, scanFlagLabels)}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <PublicSkillRunStats
            locale={uiLocale}
            signedIn={authState.isSignedIn}
            slug={skill.slug}
          />
        </aside>
      </div>

      <PublicSkillReviews
        locale={uiLocale}
        signedIn={authState.isSignedIn}
        slug={skill.slug}
      />

      <section className={`mx-auto pb-12 ${skillsContainerClassName}`}>
        <div className="border-t border-zinc-300 pt-8 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
          <h2 className="mb-3 text-base font-semibold text-zinc-950 dark:text-white">
            {t("detail.attribution.heading")}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{t("detail.attribution.source")}</span>
            {repoUrl ? (
              <SkillExternalLink href={repoUrl}>
                {repoLabel(repoUrl)}
              </SkillExternalLink>
            ) : (
              <span>{t("detail.attribution.unknownSource")}</span>
            )}
            {sourceUrl && source.repoSubpath ? (
              <>
                <span>{t("detail.attribution.inDirectory")}</span>
                <SkillExternalLink
                  className="font-mono text-xs"
                  href={sourceUrl}
                >
                  {source.repoSubpath}
                </SkillExternalLink>
              </>
            ) : null}
            {commitSha ? (
              <>
                <span>{t("detail.attribution.atCommit")}</span>
                {commitHref ? (
                  <SkillExternalLink
                    className="font-mono text-xs"
                    href={commitHref}
                  >
                    {commitSha}
                  </SkillExternalLink>
                ) : (
                  <span className="font-mono text-xs">{commitSha}</span>
                )}
              </>
            ) : null}
          </p>
          <p className="mt-1">
            {t("detail.attribution.license")} {license}
          </p>
          <p className="mt-3">{t("detail.attribution.ownership")}</p>
          <p className="mt-3">
            <a
              className="font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white"
              href={skillTakedownMailto(skill.slug)}
            >
              {t("detail.attribution.report")}
            </a>
          </p>
          <PublicSkillReport
            locale={uiLocale}
            signedIn={authState.isSignedIn}
            slug={skill.slug}
          />
        </div>
      </section>

      {related.sameRepository.length > 0 ? (
        <section className={`mx-auto pb-16 ${skillsContainerClassName}`}>
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">
              {t("detail.related.sameRepository", {
                repository: repository ?? skill.author ?? skill.displayName,
              })}
            </h2>
            <SkillCardGrid
              categoryNames={categoryNames}
              skills={related.sameRepository}
            />
          </div>
        </section>
      ) : null}

      {related.sameCategory.length > 0 && primaryCategory ? (
        <section className={`mx-auto pb-16 ${skillsContainerClassName}`}>
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">
              {t("detail.related.sameCategory", {
                category: skillCategoryLabel(primaryCategory, categoryNames),
              })}
            </h2>
            <SkillCardGrid
              categoryNames={categoryNames}
              highlightCategory={primaryCategory}
              skills={related.sameCategory}
            />
          </div>
        </section>
      ) : null}

      <SourceWeftFooter
        authState={authState}
        containerClassName={skillsContainerClassName}
      />
    </main>
  );
}
