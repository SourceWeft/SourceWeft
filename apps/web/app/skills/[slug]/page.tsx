import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type {
  GetMarketSkillResponse,
  MarketSkillSummary,
} from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { JsonLd } from "../../_components/seo/json-ld";
import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { CopyButton } from "../../mcp/_components/mcp-client";
import { NO_INDEX_METADATA, OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";
import {
  getPublicSkill,
  isMarketNotFound,
  listPublicSkillCategories,
} from "../../../lib/market-skills";
import { SkillMarkdown } from "../_components/skill-markdown";
import {
  SkillArchivedBadge,
  SkillCapabilityBadge,
  SkillCardGrid,
  skillCategoryNames,
  SkillClaimedBadge,
  SkillExternalLink,
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
import { skillsCopy } from "../_components/skills-public-copy";

// Not build-time prerendered: canonical/JSON-LD embed the public site URL, which
// is injected at container start, so a build-time render would bake in the
// wrong origin. Freshness comes from the cached market reads (60s).
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const copy = skillsCopy.detail;

async function loadSkill(slug: string) {
  try {
    return await getPublicSkill(slug);
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
  const [{ slug }, rawSearchParams] = await Promise.all([params, searchParams]);
  try {
    const { skill } = await loadSkill(decodeURIComponent(slug));
    const title = copy.metaTitle(skill.displayName);
    const description = shortSeoText(
      copy.metaDescription(skill.displayName, skill.description),
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
    return { title: copy.fallbackMetaTitle };
  }
}

/** A copyable shell command, as the install tab shows each one. */
function CommandLine({ command }: { command: string }) {
  return (
    <div className="mt-3 flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs leading-5 text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
        {command}
      </code>
      <CopyButton
        className="h-8 shrink-0 px-2"
        label={copy.install.copy}
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
  const files =
    changes.added.length + changes.removed.length + changes.modified.length;
  const compareUrl = safeExternalUrl(changes.compareUrl);
  return (
    <div className="mt-1.5 w-full space-y-1 text-xs text-zinc-500">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {files > 0
            ? [
                changes.added.length ? `${changes.added.length} added` : null,
                changes.modified.length
                  ? `${changes.modified.length} modified`
                  : null,
                changes.removed.length
                  ? `${changes.removed.length} removed`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : copy.versions.noChanges}
        </span>
        {compareUrl ? (
          <SkillExternalLink className="text-xs" href={compareUrl}>
            {copy.versions.compare}
          </SkillExternalLink>
        ) : null}
      </p>
      {changes.newScripts.length > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          {copy.versions.newScripts(changes.newScripts.join(", "))}
        </p>
      ) : null}
      {changes.newFlags.length > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          {copy.versions.newFlags(
            changes.newFlags.map((flag) => scanFlagLabel(flag)).join(", "),
          )}
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
  const chatPrompt = copy.install.chatPrompt(skill.slug);
  return (
    <div className={className}>
      <Link
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-100"
        href={installHref}
        prefetch={false}
        rel="nofollow"
      >
        {copy.install.cta}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{copy.install.chatLead}</span>
        <code className="min-w-0 break-all rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
          {chatPrompt}
        </code>
        <CopyButton
          className="h-6 px-2"
          label={copy.install.copy}
          value={chatPrompt}
        />
      </div>
    </div>
  );
}

function FilesTab({ files }: { files: GetMarketSkillResponse["files"] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {copy.files.note}
      </p>
      {files.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-300 bg-white/58 dark:border-white/10 dark:bg-white/[0.03]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-white/10">
              <tr>
                <th className="px-5 py-3 font-medium" scope="col">
                  {copy.files.path}
                </th>
                <th className="px-5 py-3 text-right font-medium" scope="col">
                  {copy.files.size}
                </th>
                <th className="px-5 py-3 font-medium" scope="col">
                  {copy.files.type}
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
                    {file.mimeType ?? copy.files.unknownType}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={`${panelClassName} text-sm text-zinc-500`}>
          {copy.files.empty}
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
  if (versions.length === 0) {
    return (
      <p className={`${panelClassName} text-sm text-zinc-500`}>
        {copy.versions.empty}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {versions.map((entry) => {
        const published = formatSkillDate(entry.publishedAt);
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
                  {copy.versions.current}
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 text-zinc-500">
              {sha ? (
                <span className="inline-flex items-center gap-1.5">
                  {copy.versions.commit}{" "}
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
                  ? copy.versions.published(published)
                  : copy.versions.unpublishedDate}
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
  const [{ slug }, rawSearchParams] = await Promise.all([params, searchParams]);
  const decodedSlug = decodeURIComponent(slug);
  const tab = parseSkillDetailTab(rawSearchParams.tab);
  const [authState, result, categoriesResponse] = await Promise.all([
    resolveInitialLandingAuthState(),
    loadSkill(decodedSlug),
    listPublicSkillCategories(),
  ]);
  const { files, scanFlags, skill, source, versions } = result;
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
  const pushed = formatRelativeTime(skill.repoPushedAt);
  const license = skill.license ?? copy.noLicense;
  const listed = formatSkillDate(skill.listedAt);
  const updated = formatSkillDate(skill.updatedAt);
  const primaryCategory = skill.categories[0];
  const pageUrl = `${SITE_URL}${skillPath(skill.slug)}`;

  const tabs: [SkillDetailTab, string][] = [
    ["skill", copy.tabs.skill],
    ["files", copy.tabs.files(files.length)],
    ["versions", copy.tabs.versions(versions.length)],
    ["install", copy.tabs.install],
  ];
  const facts: [string, string][] = [
    [copy.facts.version, formatSkillVersion(skill.version)],
    [copy.facts.license, license],
    ...(skill.installCount > 0
      ? ([[copy.facts.workspaces, formatCompactCount(skill.installCount)]] as [
          string,
          string,
        ][])
      : []),
    ...(stars > 0
      ? ([[copy.facts.stars, formatCompactCount(stars)]] as [string, string][])
      : []),
    [copy.facts.files, files.length.toLocaleString("en")],
  ];
  const details: [string, string][] = [
    [copy.details.slug, skill.slug],
    [copy.details.name, skill.name],
    ...(skill.author
      ? ([[copy.details.author, skill.author]] as [string, string][])
      : []),
    ...(skill.capability
      ? ([
          [
            copy.details.type,
            skill.capability === "executable"
              ? skillsCopy.badges.executable
              : skillsCopy.badges.promptOnly,
          ],
        ] as [string, string][])
      : []),
    [
      copy.details.trust,
      skill.verified ? skillsCopy.badges.verified : copy.details.unverified,
    ],
    ...(listed ? ([[copy.details.listed, listed]] as [string, string][]) : []),
    ...(updated
      ? ([[copy.details.updated, updated]] as [string, string][])
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
        name: skillsCopy.breadcrumb.home,
        position: 1,
      },
      {
        "@type": "ListItem",
        item: `${SITE_URL}/skills`,
        name: skillsCopy.breadcrumb.skills,
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
            aria-label={skillsCopy.breadcrumb.label}
            className="mb-8 flex min-w-0 items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400"
          >
            <Link
              className="shrink-0 hover:text-zinc-950 dark:hover:text-white"
              href="/skills"
            >
              {skillsCopy.breadcrumb.skills}
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
                        {copy.by}{" "}
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {skill.author}
                        </span>
                      </span>
                    ) : null}
                    <span>{formatSkillVersion(skill.version)}</span>
                    <span>{license}</span>
                    {skill.installCount > 0 ? (
                      <span>
                        {copy.workspaces(
                          formatCompactCount(skill.installCount),
                        )}
                      </span>
                    ) : null}
                    {stars > 0 ? (
                      <span>{copy.stars(formatCompactCount(stars))}</span>
                    ) : null}
                    {listed ? <span>{copy.listed(listed)}</span> : null}
                    {updated ? <span>{copy.updated(updated)}</span> : null}
                    {pushed ? <span>{copy.repoPushed(pushed)}</span> : null}
                  </p>
                </div>
              </div>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
                {skill.description}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
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
                    {copy.repository}
                  </SkillExternalLink>
                ) : null}
                {sourceUrl ? (
                  <SkillExternalLink href={sourceUrl}>
                    {copy.source}
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
                    {copy.claimLink}
                  </Link>
                </p>
              ) : null}
            </aside>
          </div>
        </div>
      </section>

      <nav
        aria-label={copy.tabsLabel}
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
            skillMd ? (
              <article className={`${panelClassName} min-w-0 sm:p-7`}>
                <SkillMarkdown>{skillMd}</SkillMarkdown>
              </article>
            ) : (
              <p className={`${panelClassName} text-sm text-zinc-500`}>
                {copy.skillMdMissing}
              </p>
            )
          ) : null}

          {tab === "files" ? <FilesTab files={files} /> : null}

          {tab === "versions" ? (
            <VersionsTab repoUrl={repoUrl} versions={versions} />
          ) : null}

          {tab === "install" ? (
            <div className={panelClassName}>
              <h2 className="text-lg font-semibold">{copy.install.heading}</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {copy.install.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {skill.capability ? (
                <p className="mt-4 rounded-lg bg-zinc-100 p-3 text-xs leading-5 text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                  {skill.capability === "executable"
                    ? copy.install.executableNote
                    : copy.install.promptOnlyNote}
                </p>
              ) : null}
              <InstallCta
                className="mt-5 max-w-sm"
                installHref={installHref}
                skill={skill}
              />
              {authState.isSignedIn ? null : (
                <p className="mt-3 text-xs text-zinc-500">
                  {copy.install.signedOutNote}
                </p>
              )}
              {cliInstallCommand ? (
                <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-white/10">
                  <h3 className="text-base font-semibold">
                    {copy.install.cli.heading}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {copy.install.cli.lead}
                  </p>
                  <CommandLine command={cliInstallCommand} />
                  <p className="mt-2 text-xs leading-5 text-zinc-500">
                    {copy.install.cli.agentHint}
                  </p>
                  {skill.capability === "executable" ? (
                    <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
                      {copy.install.cli.executableNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {localInstallCommand ? (
                <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-white/10">
                  <h3 className="text-base font-semibold">
                    {copy.install.upstream.heading}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {copy.install.upstream.lead}
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
              {copy.details.heading}
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
                {copy.scan.heading}
              </div>
              <p>{copy.scan.body}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                {scanFlags.map((flag) => (
                  <li key={flag}>{scanFlagLabel(flag)}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>

      <section className={`mx-auto pb-12 ${skillsContainerClassName}`}>
        <div className="border-t border-zinc-300 pt-8 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:text-zinc-400">
          <h2 className="mb-3 text-base font-semibold text-zinc-950 dark:text-white">
            {copy.attribution.heading}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{copy.attribution.source}</span>
            {repoUrl ? (
              <SkillExternalLink href={repoUrl}>
                {repoLabel(repoUrl)}
              </SkillExternalLink>
            ) : (
              <span>{copy.attribution.unknownSource}</span>
            )}
            {sourceUrl && source.repoSubpath ? (
              <>
                <span>{copy.attribution.inDirectory}</span>
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
                <span>{copy.attribution.atCommit}</span>
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
            {copy.attribution.license} {license}
          </p>
          <p className="mt-3">{copy.attribution.ownership}</p>
          <p className="mt-3">
            <a
              className="font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white"
              href={skillTakedownMailto(skill.slug)}
            >
              {copy.attribution.report}
            </a>
          </p>
        </div>
      </section>

      {related.sameRepository.length > 0 ? (
        <section className={`mx-auto pb-16 ${skillsContainerClassName}`}>
          <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
            <h2 className="mb-6 text-2xl font-semibold tracking-tight">
              {copy.related.sameRepository(
                repository ?? skill.author ?? skill.displayName,
              )}
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
              {copy.related.sameCategory(
                skillCategoryLabel(primaryCategory, categoryNames),
              )}
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
