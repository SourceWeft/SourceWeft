import type { MouseEvent } from "react";
import Link from "next/link";
import { ArrowUpCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import { SkillAvatar } from "../../../../skills/_components/skill-avatar";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { TypeBadge } from "../type-badge";
import type { HubSkillItem, SkillIconSpec } from "./use-skills";

function skillSourceKey(sourceType: HubSkillItem["sourceType"]) {
  if (sourceType === "builtin") return "builtin";
  if (sourceType === "team_custom") return "team";
  if (sourceType === "registry_github") return "community";
  return "workspace";
}

/** The skill's dashboard page, opened at its version control. */
export function skillUpdateHref(slug: string) {
  return `/dashboard/skills/${encodeURIComponent(slug)}#versions`;
}

export function SkillRow({
  icon,
  skill,
  selected,
  disabled,
  busy,
  onToggle,
  onOpenSkill,
}: {
  icon?: SkillIconSpec;
  skill: HubSkillItem;
  selected: boolean;
  disabled?: boolean;
  busy?: boolean;
  onToggle: (id: string) => void | Promise<void>;
  onOpenSkill: (catalogId: string) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const tm = useTranslations("dashboardSkillsMarket");
  function handleRowClick(event: MouseEvent<HTMLElement>) {
    if (disabled) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,select,a,[role='button']")) {
      return;
    }

    void onToggle(skill.id);
  }

  return (
    <article
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
        selected ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-accent/60",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        busy && "cursor-wait opacity-70",
      )}
      onClick={handleRowClick}
    >
      <Checkbox
        checked={selected}
        className="mt-0.5"
        disabled={disabled || busy}
        onCheckedChange={() => void onToggle(skill.id)}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <SkillAvatar
            item={skill}
            icon={icon}
            className="size-4 rounded-sm text-xs"
          />
          <button
            className="cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => onOpenSkill(skill.catalogId)}
            title={t("skills.openIntro")}
            type="button"
          >
            {skill.displayName}
          </button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
          {skill.description}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <TypeBadge label={t(`skills.source.${skillSourceKey(skill.sourceType)}`)} />
          {disabled ? <TypeBadge label={t("skills.toolOff")} /> : null}
          {skill.sourceType !== "builtin" ? (
            <TypeBadge label={selected ? t("skills.hubOn") : t("skills.hubOff")} />
          ) : null}
          {/*
            The agent installs skills on its own when a task calls for one, and
            acts as the user while doing so — this is the only place a person
            can see which skills arrived that way.
          */}
          {skill.installedVia === "agent" ? (
            <TypeBadge label={t("skills.addedByAgent")} />
          ) : null}
          {/*
            An install stays on the version it was made with. This only points
            at the skill's page, where updating asks first when the newer
            version can do more — nothing is updated from here. Only community
            skills have that version switch.
          */}
          {skill.updateAvailable && skill.sourceType === "registry_github" ? (
            <Link
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={skillUpdateHref(skill.slug)}
              title={tm("updates.hubBadgeTitle")}
            >
              <ArrowUpCircle aria-hidden className="size-3" />
              {tm("updates.hubBadge")}
            </Link>
          ) : null}
          {/*
            A switched-off skill that ships scripts says so, so whoever turns it
            back on knows that doing so makes code runnable, not just
            instructions.
          */}
          {skill.registryCapability === "executable" && !selected ? (
            <TypeBadge label={t("skills.shipsScripts")} />
          ) : null}
        </div>
      </div>
    </article>
  );
}
