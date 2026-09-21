import Link from "next/link";
import {
  Archive,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ExternalLink,
  FileText,
  Layers,
  Sparkles,
  Star,
  TerminalSquare,
} from "lucide-react";
import type {
  MarketSkillCapability,
  MarketSkillCategory,
  MarketSkillCollection,
  MarketSkillSummary,
} from "@sourceweft/market-sdk";
import { useLocale, useTranslations } from "next-intl";

import { cn } from "@sourceweft/ui-web/lib/utils";

import {
  formatCompactCount,
  formatRelativeTime,
  formatSkillDate,
  skillCategoryLabel,
  skillCollectionPath,
  skillPath,
  skillsContainerClassName,
} from "./skills-format";
import { publicOverviewCopy } from "./community/public-overview-copy";
import { SkillTile } from "./skill-logo";

/**
 * What a card says about a skill: the AI summary in the visitor's language
 * when the market has one, else the author's own description. Plain text
 * either way.
 */
export function skillCardText(
  skill: Pick<MarketSkillSummary, "aiSummary" | "description">,
): { text: string; ai: boolean } {
  const summary = skill.aiSummary?.trim();
  return summary
    ? { text: summary, ai: true }
    : { text: skill.description, ai: false };
}

export function skillCategoryNames(categories: MarketSkillCategory[]) {
  return new Map(categories.map((category) => [category.slug, category.name]));
}

export function SkillBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        tone === "good" &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-200",
        tone === "warn" &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-200",
        tone === "neutral" &&
          "border-zinc-300 bg-white/70 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

export function SkillVerifiedBadge() {
  const t = useTranslations("publicSkills.badges");
  return (
    <SkillBadge tone="good">
      <CheckCircle2 className="size-3.5" />
      {t("verified")}
    </SkillBadge>
  );
}

/**
 * From a featured publisher. Quieter than Verified on purpose: it says who
 * publishes the skill, not that anyone reviewed it.
 */
export function SkillFeaturedBadge() {
  const t = useTranslations("publicSkills.badges");
  return (
    <span title={t("featuredTitle")}>
      <SkillBadge>
        <Sparkles className="size-3.5 text-amber-500 dark:text-amber-300" />
        {t("featured")}
      </SkillBadge>
    </span>
  );
}

/** The repository's author claimed it on SourceWeft. */
export function SkillClaimedBadge() {
  const t = useTranslations("publicSkills.badges");
  return (
    <span title={t("claimedTitle")}>
      <SkillBadge>
        <BadgeCheck className="size-3.5" />
        {t("claimed")}
      </SkillBadge>
    </span>
  );
}

/** The source repository is archived on GitHub: no more updates will come. */
export function SkillArchivedBadge() {
  const t = useTranslations("publicSkills.badges");
  return (
    <span title={t("archivedTitle")}>
      <SkillBadge tone="warn">
        <Archive className="size-3.5" />
        {t("archived")}
      </SkillBadge>
    </span>
  );
}

/** Nothing for an unknown capability: we do not guess either way. */
export function SkillCapabilityBadge({
  capability,
}: {
  capability: MarketSkillCapability | null;
}) {
  const t = useTranslations("publicSkills.badges");
  if (capability === "executable") {
    return (
      <SkillBadge tone="warn">
        <TerminalSquare className="size-3.5" />
        {t("executable")}
      </SkillBadge>
    );
  }
  if (capability === "prompt-only") {
    return (
      <SkillBadge>
        <FileText className="size-3.5" />
        {t("promptOnly")}
      </SkillBadge>
    );
  }
  return null;
}

export function SkillMarketCard({
  categoryNames,
  highlightCategory,
  skill,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  /** Category to show when the skill has several, e.g. the one being browsed. */
  highlightCategory?: string;
  skill: MarketSkillSummary;
}) {
  const t = useTranslations("publicSkills.card");
  const locale = useLocale();
  const primaryCategory =
    highlightCategory && skill.categories.includes(highlightCategory)
      ? highlightCategory
      : skill.categories[0];
  // When the repository was last pushed, once GitHub has been asked; until
  // then, when this version was published here.
  const pushed = formatRelativeTime(skill.repoPushedAt, undefined, locale);
  const updated = pushed
    ? t("updated", { relative: pushed })
    : formatSkillDate(skill.updatedAt ?? skill.listedAt, locale);
  const stars = skill.stars ?? 0;
  const badges =
    skill.capability === "executable" || skill.claimed || skill.repoArchived;
  const cardText = skillCardText(skill);
  return (
    <Link
      className="group flex h-full flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-950/40 hover:bg-white hover:shadow-[0_18px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
      href={skillPath(skill.slug)}
    >
      <div className="flex items-start gap-3">
        <SkillTile logo={skill.logo} verified={skill.verified} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold leading-6 text-zinc-950 dark:text-white">
            {skill.displayName}
          </h3>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {skill.author ?? skill.slug}
          </p>
        </div>
        {skill.featured || skill.verified ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {skill.featured ? <SkillFeaturedBadge /> : null}
            {skill.verified ? <SkillVerifiedBadge /> : null}
          </div>
        ) : null}
      </div>

      <p
        className="mt-4 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
        {...(cardText.ai
          ? {
              "data-ai-summary": "",
              title: publicOverviewCopy(locale).cardSummaryTitle,
            }
          : {})}
      >
        {cardText.text}
      </p>

      {badges ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {skill.capability === "executable" ? (
            <SkillCapabilityBadge capability={skill.capability} />
          ) : null}
          {skill.claimed ? <SkillClaimedBadge /> : null}
          {skill.repoArchived ? <SkillArchivedBadge /> : null}
        </div>
      ) : null}

      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-white/10">
          {primaryCategory ? (
            <span className="min-w-0 truncate">
              {skillCategoryLabel(primaryCategory, categoryNames)}
            </span>
          ) : null}
          {stars > 0 ? (
            <span
              aria-label={t("stars", { count: formatCompactCount(stars) })}
              className="inline-flex shrink-0 items-center gap-1"
              title={t("stars", { count: formatCompactCount(stars) })}
            >
              <Star className="size-3.5" />
              {formatCompactCount(stars)}
            </span>
          ) : null}
          {updated ? <span className="ml-auto shrink-0">{updated}</span> : null}
        </div>
        {skill.installCount > 0 ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-zinc-500">
            <Layers className="size-3.5" />
            {t("workspaces", {
              compact: formatCompactCount(skill.installCount),
              count: skill.installCount,
            })}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

export function SkillCardGrid({
  categoryNames,
  className,
  highlightCategory,
  skills,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  className?: string;
  highlightCategory?: string;
  skills: MarketSkillSummary[];
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {skills.map((skill) => (
        <SkillMarketCard
          categoryNames={categoryNames}
          highlightCategory={highlightCategory}
          key={skill.slug}
          skill={skill}
        />
      ))}
    </div>
  );
}

export function SkillDirectorySection({
  categoryNames,
  description,
  skills,
  title,
  viewAllHref,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  description: string;
  skills: MarketSkillSummary[];
  title: string;
  viewAllHref: string;
}) {
  const t = useTranslations("publicSkills.landing");
  if (skills.length === 0) {
    return null;
  }
  return (
    <section>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {title}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        </div>
        <Link
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          href={viewAllHref}
        >
          {t("viewAll")}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <SkillCardGrid categoryNames={categoryNames} skills={skills} />
    </section>
  );
}

/** The published collections, as links to their pages. Nothing when none. */
export function SkillCollectionsSection({
  collections,
}: {
  collections: MarketSkillCollection[];
}) {
  const t = useTranslations("publicSkills");
  const shown = collections.filter((collection) => collection.itemCount > 0);
  if (shown.length === 0) {
    return null;
  }
  const title = t("landing.sections.collections.title");
  const description = t("landing.sections.collections.description");
  return (
    <section>
      <div className="mb-5 min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
          {title}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((collection) => (
          <Link
            className="group flex flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 transition-colors hover:border-zinc-950/40 hover:bg-white dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/35"
            href={skillCollectionPath(collection.slug)}
            key={collection.slug}
          >
            <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
              {collection.title}
            </h3>
            {collection.summary ? (
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {collection.summary}
              </p>
            ) : null}
            <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-xs font-medium text-zinc-500 group-hover:text-zinc-950 dark:group-hover:text-white">
              {t("collections.itemCount", { count: collection.itemCount })}
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * A link to a third-party address the market API gave us (repository, source
 * directory, commit). User-generated, so search engines are told not to follow.
 */
export function SkillExternalLink({
  children,
  className,
  href,
}: {
  children: React.ReactNode;
  className?: string;
  href: string;
}) {
  return (
    <a
      className={cn(
        "inline-flex items-center gap-1.5 font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white",
        className,
      )}
      href={href}
      // Spelled out (it is UNTRUSTED_LINK_REL) so the lint rule that guards
      // target="_blank" can see the noreferrer.
      rel="nofollow ugc noopener noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

/** FAQ entries, in page order; each is `publicSkills.faq.items.<key>`. */
export const skillsFaqKeys = [
  "what",
  "use",
  "standalone",
  "origin",
  "safety",
  "removal",
] as const;

export function SkillsFaqSection() {
  const t = useTranslations("publicSkills.faq");
  return (
    <section className={`mx-auto pb-16 ${skillsContainerClassName}`}>
      <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
        <div className="mb-7 max-w-2xl">
          <p className="text-xs font-semibold uppercase text-zinc-400">
            {t("heading")}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">
            {t("title")}
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {skillsFaqKeys.map((key) => (
            <article
              className="rounded-lg border border-zinc-300 bg-white/54 p-5 dark:border-white/10 dark:bg-white/[0.03]"
              key={key}
            >
              <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                {t(`items.${key}.question`)}
              </h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t(`items.${key}.answer`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
