import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { SkillIcon } from "../../../../_components/dashboard-icons";
import {
  MAX_SELECTED_SKILL_IDS_PER_TURN,
  toggleSkillSelection,
} from "../../chat-canvas/tool-selection";
import { HubEmptyState } from "../components/hub-empty-state";
import { SkillRow } from "./skill-row";
import type { HubSkillItem, SkillIconSpec } from "./use-skills";

export function SkillsTab({
  skills,
  skillIconsById,
  searchQuery,
  selectedSkillIds,
  onSkillSelectionChange,
  onWorkspaceSkillEnabledChange,
  onOpenSkill,
  disabledToolNames = [],
}: {
  skills: HubSkillItem[];
  skillIconsById?: ReadonlyMap<string, SkillIconSpec>;
  searchQuery: string;
  selectedSkillIds: string[];
  onSkillSelectionChange: (ids: string[]) => void;
  onWorkspaceSkillEnabledChange?: (
    skill: HubSkillItem,
    enabled: boolean,
  ) => void | Promise<void>;
  onOpenSkill: (catalogId: string) => void;
  disabledToolNames?: string[];
}) {
  const t = useTranslations("dashboardSourcesHub");
  const tCanvas = useTranslations("dashboardChatCanvas");
  const [busySkillIds, setBusySkillIds] = useState<Set<string>>(new Set());
  const q = searchQuery.trim().toLowerCase();
  const selectedSet = useMemo(
    () => new Set(selectedSkillIds),
    [selectedSkillIds],
  );
  const disabledToolSet = useMemo(
    () => new Set(disabledToolNames),
    [disabledToolNames],
  );
  const filtered = useMemo(
    () =>
      q
        ? skills.filter(
            (skill) =>
              skill.displayName.toLowerCase().includes(q) ||
              skill.description.toLowerCase().includes(q) ||
              skill.name.toLowerCase().includes(q),
          )
        : skills,
    [q, skills],
  );

  async function toggleSkill(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill || busySkillIds.has(skillId)) {
      return;
    }
    if (
      skill.sourceType === "builtin" &&
      skill.tools?.some((toolName) => disabledToolSet.has(toolName))
    ) {
      return;
    }
    if (skill.sourceType !== "builtin" && skill.workspaceSkillId) {
      if (!onWorkspaceSkillEnabledChange) {
        return;
      }
      const nextEnabled = !skill.enabled;
      setBusySkillIds((current) => new Set(current).add(skillId));
      try {
        await onWorkspaceSkillEnabledChange(skill, nextEnabled);
      } finally {
        setBusySkillIds((current) => {
          const next = new Set(current);
          next.delete(skillId);
          return next;
        });
      }
      return;
    }
    if (selectedSet.has(skillId)) {
      onSkillSelectionChange(selectedSkillIds.filter((id) => id !== skillId));
      return;
    }
    const { skillIds, wasLimited } = toggleSkillSelection({
      currentSkillIds: selectedSkillIds,
      selected: true,
      skillId,
    });
    if (wasLimited) {
      toast.info(
        tCanvas("composer.skillLimit", { max: MAX_SELECTED_SKILL_IDS_PER_TURN }),
      );
      return;
    }
    onSkillSelectionChange(skillIds);
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? t("skills.noMatchDescription")
            : t("skills.emptyDescription")
        }
        icon={SkillIcon}
        title={
          searchQuery
            ? t("skills.noMatchTitle", { query: searchQuery })
            : t("skills.emptyTitle")
        }
      />
    );
  }

  return (
    <div className="space-y-0.5">
      {filtered.map((skill) => {
        const hasDisabledTool =
          skill.tools?.some((toolName) => disabledToolSet.has(toolName)) ??
          false;
        return (
          <SkillRow
            busy={busySkillIds.has(skill.id)}
            disabled={skill.sourceType === "builtin" && hasDisabledTool}
            icon={skillIconsById?.get(skill.id)}
            key={skill.id}
            onOpenSkill={onOpenSkill}
            onToggle={toggleSkill}
            selected={
              skill.sourceType !== "builtin" && skill.workspaceSkillId
                ? skill.enabled === true
                : selectedSet.has(skill.id)
            }
            skill={skill}
          />
        );
      })}
    </div>
  );
}
