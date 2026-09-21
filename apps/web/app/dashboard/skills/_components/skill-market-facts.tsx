import { BadgeCheck, Download, Sparkles, SquareTerminal } from "lucide-react";
import type { SkillCatalogCategory } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatInstallCount, skillCategoryName } from "./skills-market-browse";
import { skillsMarketCopy } from "./skills-market-copy";

const copy = skillsMarketCopy;

/**
 * A skill's market facts for a detail header: featured and verified marks,
 * categories, capability hint and install count. Renders nothing for a skill
 * that has none of them (built-ins and a workspace's own skills mostly do not).
 */
export function SkillMarketFacts({
  categories,
  className,
  item,
}: {
  categories: readonly Pick<SkillCatalogCategory, "slug" | "name">[];
  className?: string;
  item: {
    sourceType: string;
    verified?: boolean;
    featured?: boolean;
    categories: readonly string[];
    capability?: "prompt-only" | "executable" | null;
    installCount?: number;
  };
}) {
  const isRegistry = item.sourceType === "registry_github";
  const categorySlugs = item.categories
    .map((slug) => slug.trim())
    .filter(Boolean);
  const installCount = formatInstallCount(item.installCount);
  const installCountLabel =
    item.installCount === 1
      ? copy.card.installsOne
      : installCount
        ? copy.card.installs(installCount)
        : null;
  const verified = isRegistry && item.verified === true;
  const featured = isRegistry && item.featured === true;
  const executable = item.capability === "executable";

  if (
    !featured &&
    !verified &&
    !executable &&
    categorySlugs.length === 0 &&
    !installCountLabel
  ) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {featured ? (
        <Badge
          className="h-5 gap-1 px-1.5 text-[10px]"
          title={copy.card.featuredTitle}
          variant="outline"
        >
          <Sparkles className="size-2.5 text-amber-500 dark:text-amber-300" />
          {copy.card.featured}
        </Badge>
      ) : null}
      {verified ? (
        <Badge className="h-5 gap-1 px-1.5 text-[10px]" variant="secondary">
          <BadgeCheck className="size-2.5" />
          {copy.card.verified}
        </Badge>
      ) : null}
      {categorySlugs.map((slug) => (
        <Badge className="h-5 px-1.5 text-[10px]" key={slug} variant="outline">
          {skillCategoryName(slug, categories)}
        </Badge>
      ))}
      {executable ? (
        <Badge
          className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
          variant="outline"
        >
          <SquareTerminal className="size-2.5" />
          {copy.card.includesScripts}
        </Badge>
      ) : null}
      {installCountLabel ? (
        <span className="inline-flex h-5 items-center gap-1 text-[11px] text-muted-foreground">
          <Download className="size-3" />
          {installCountLabel}
        </span>
      ) : null}
    </div>
  );
}
