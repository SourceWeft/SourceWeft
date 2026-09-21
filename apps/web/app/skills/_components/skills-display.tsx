import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  TerminalSquare,
} from "lucide-react";
import type {
  MarketSkillCapability,
  MarketSkillCategory,
  MarketSkillSummary,
} from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { SkillIcon } from "../../_components/site-icons";
import {
  formatCompactCount,
  formatSkillDate,
  skillCategoryLabel,
  skillPath,
  skillsContainerClassName,
} from "./skills-format";
import { skillsCopy } from "./skills-public-copy";

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
  return (
    <SkillBadge tone="good">
      <CheckCircle2 className="size-3.5" />
      {skillsCopy.badges.verified}
    </SkillBadge>
  );
}

/** Nothing for an unknown capability: we do not guess either way. */
export function SkillCapabilityBadge({
  capability,
}: {
  capability: MarketSkillCapability | null;
}) {
  if (capability === "executable") {
    return (
      <SkillBadge tone="warn">
        <TerminalSquare className="size-3.5" />
        {skillsCopy.badges.executable}
      </SkillBadge>
    );
  }
  if (capability === "prompt-only") {
    return (
      <SkillBadge>
        <FileText className="size-3.5" />
        {skillsCopy.badges.promptOnly}
      </SkillBadge>
    );
  }
  return null;
}

export function SkillTile({
  size = "md",
  verified,
}: {
  size?: "md" | "lg";
  verified: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl",
        size === "lg" ? "size-16" : "size-11",
        verified
          ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
          : "bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-200",
      )}
    >
      <SkillIcon className={size === "lg" ? "size-7" : "size-5"} />
    </span>
  );
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
  const primaryCategory =
    highlightCategory && skill.categories.includes(highlightCategory)
      ? highlightCategory
      : skill.categories[0];
  const updated = formatSkillDate(skill.updatedAt ?? skill.listedAt);
  return (
    <Link
      className="group flex h-full flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-950/40 hover:bg-white hover:shadow-[0_18px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
      href={skillPath(skill.slug)}
    >
      <div className="flex items-start gap-3">
        <SkillTile verified={skill.verified} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold leading-6 text-zinc-950 dark:text-white">
            {skill.displayName}
          </h3>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {skill.author ?? skill.slug}
          </p>
        </div>
        {skill.verified ? <SkillVerifiedBadge /> : null}
      </div>

      <p className="mt-4 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {skill.description}
      </p>

      {skill.capability === "executable" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <SkillCapabilityBadge capability={skill.capability} />
        </div>
      ) : null}

      <div className="mt-auto pt-4">
        <div className="flex items-center gap-x-4 gap-y-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-white/10">
          {primaryCategory ? (
            <span className="min-w-0 truncate">
              {skillCategoryLabel(primaryCategory, categoryNames)}
            </span>
          ) : null}
          {skill.installCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Download className="size-3.5" />
              {skillsCopy.card.installs(formatCompactCount(skill.installCount))}
            </span>
          ) : null}
          {updated ? <span className="ml-auto shrink-0">{updated}</span> : null}
        </div>
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
          {skillsCopy.landing.viewAll}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <SkillCardGrid categoryNames={categoryNames} skills={skills} />
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

export function SkillsFaqSection() {
  return (
    <section className={`mx-auto pb-16 ${skillsContainerClassName}`}>
      <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
        <div className="mb-7 max-w-2xl">
          <p className="text-xs font-semibold uppercase text-zinc-400">
            {skillsCopy.faqHeading}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">
            {skillsCopy.faqTitle}
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {skillsCopy.faq.map((item) => (
            <article
              className="rounded-lg border border-zinc-300 bg-white/54 p-5 dark:border-white/10 dark:bg-white/[0.03]"
              key={item.question}
            >
              <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                {item.question}
              </h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {item.answer}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
