"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { AGENT_TASK_LIMITS } from "@sourceweft/contracts/scheduled-tasks";
import { MAX_SELECTED_SKILLS_PER_TURN } from "@sourceweft/contracts/threads";
import { contentClient } from "../../../../lib/sdk";
import {
  ResourcePickerPanel,
  toggleChoice,
  WorkspaceSourcePicker,
  type ResourceChoice,
} from "../../_components/resource-picker";

type PickerProps = {
  workspaceId: string | null;
  /** Fetches only while the form is open. */
  enabled: boolean;
  value: string[];
  onChange: (value: string[]) => void;
};

/** The workspace sources a scheduled run reads from. */
export function SourcePicker({
  workspaceId,
  enabled,
  value,
  onChange,
}: PickerProps) {
  const t = useTranslations("dashboardScheduled");
  return (
    <WorkspaceSourcePicker
      workspaceId={workspaceId}
      enabled={enabled}
      value={value}
      onChange={onChange}
      limit={AGENT_TASK_LIMITS.maxSources}
      labels={{
        label: t("form.sources"),
        hint: t("form.sourcesHint"),
        addLabel: t("form.addSource"),
        searchLabel: t("form.searchSources"),
        emptyLabel: t("form.noSources"),
        moreLabel: t("form.showMore"),
        limitLabel: t("form.sourcesLimit", {
          count: AGENT_TASK_LIMITS.maxSources,
        }),
        untitled: t("form.untitledSource"),
        unavailable: t("form.unavailableSource"),
      }}
    />
  );
}

/** The skills a scheduled run may use, by the ids the chat sends. */
export function SkillPicker({
  workspaceId,
  enabled,
  value,
  onChange,
}: PickerProps) {
  const t = useTranslations("dashboardScheduled");
  const skills = useQuery({
    queryKey: ["scheduled", workspaceId, "skills"],
    queryFn: async () => {
      const [installed, catalog] = await Promise.all([
        contentClient.listWorkspaceSkills(workspaceId!),
        contentClient.listSkillsCatalog(workspaceId!),
      ]);
      const choices: ResourceChoice[] = [];
      for (const skill of catalog.items) {
        if (
          skill.sourceType === "builtin" &&
          !skill.installable &&
          skill.selectionId
        ) {
          choices.push({
            id: skill.selectionId,
            title: skill.displayName || skill.name,
          });
        }
      }
      for (const skill of installed.items) {
        if (skill.enabled) {
          choices.push({
            id: skill.selectionId,
            title: skill.displayName || skill.name,
          });
        }
      }
      return choices;
    },
    enabled: enabled && Boolean(workspaceId),
    staleTime: 30_000,
  });
  const options = skills.data ?? [];
  const known = new Map(options.map((option) => [option.id, option.title]));
  const selected = value.map((id) => ({
    id,
    title:
      known.get(id) ?? (skills.isLoading ? "…" : t("form.unavailableSkill")),
  }));

  return (
    <ResourcePickerPanel
      label={t("form.skills")}
      hint={t("form.skillsHint")}
      addLabel={t("form.addSkill")}
      searchLabel={t("form.searchSkills")}
      emptyLabel={t("form.noSkills")}
      moreLabel={t("form.showMore")}
      limitLabel={t("form.skillsLimit", {
        count: MAX_SELECTED_SKILLS_PER_TURN,
      })}
      limit={MAX_SELECTED_SKILLS_PER_TURN}
      selected={selected}
      options={options}
      loading={skills.isLoading}
      onToggle={(id) => onChange(toggleChoice(value, id))}
    />
  );
}
