import type { MouseEvent } from "react";

import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import { GlobalIcon } from "@sourceweft/ui-web/components/ui/global-icon";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { SkillIcon } from "../../../../_components/dashboard-icons";
import { TypeBadge } from "../type-badge";
import {
  skillSourceLabel,
  type HubSkillItem,
  type SkillIconSpec,
} from "./use-skills";

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
          <SkillRowIcon icon={icon} selected={selected} />
          <button
            className="cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => onOpenSkill(skill.catalogId)}
            title="Open skill introduction"
            type="button"
          >
            {skill.displayName}
          </button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
          {skill.description}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <TypeBadge label={skillSourceLabel(skill.sourceType)} />
          {disabled ? <TypeBadge label="Tool off" /> : null}
          {skill.sourceType !== "builtin" ? (
            <TypeBadge label={selected ? "Hub on" : "Hub off"} />
          ) : null}
        </div>
      </div>
    </article>
  );
}

function SkillRowIcon({
  icon,
  selected,
}: {
  icon?: SkillIconSpec;
  selected: boolean;
}) {
  const className = cn(
    "size-3 shrink-0",
    selected ? "text-primary" : "text-muted-foreground",
  );
  if (icon?.iconName) {
    return (
      <GlobalIcon
        className={className}
        fallbackIconName="skill"
        iconName={icon.iconName}
        iconTone={icon.iconTone ?? "mono"}
      />
    );
  }

  return <SkillIcon className={className} />;
}
