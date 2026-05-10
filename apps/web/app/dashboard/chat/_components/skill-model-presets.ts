import type { ChatSkillItem } from "./chat-canvas";
import {
  findModelItemByAlias,
  type ModelItem,
  type ModelType,
  type SelectedModels,
} from "./header-model-selector";

export type ModelSelectionSource = "system" | "skill" | "user";

export type ModelSelectionSources = Record<ModelType, ModelSelectionSource>;

export const DEFAULT_MODEL_SELECTION_SOURCES: ModelSelectionSources = {
  image: "system",
  llm: "system",
  vision: "system",
};

const SKILL_MODEL_KEY_BY_TYPE = {
  image: "image",
  llm: "chat",
  vision: "vision",
} as const satisfies Record<
  ModelType,
  keyof NonNullable<ChatSkillItem["models"]>
>;

export function resolveSkillModelAliasForType(input: {
  activeSkillIds: string[];
  availableSkills: ChatSkillItem[];
  type: ModelType;
}) {
  const skillById = new Map(input.availableSkills.map((skill) => [skill.id, skill]));
  const modelKey = SKILL_MODEL_KEY_BY_TYPE[input.type];
  for (const skillId of input.activeSkillIds) {
    const alias = skillById.get(skillId)?.models?.[modelKey];
    if (typeof alias === "string" && alias.trim().length > 0) {
      return alias.trim();
    }
  }
  return null;
}

function sameModel(left: ModelItem | null, right: ModelItem | null) {
  return left?.id === right?.id;
}

export function applySkillModelPresetState(input: {
  activeSkillIds: string[];
  availableModels: Record<ModelType, ModelItem[]>;
  availableSkills: ChatSkillItem[];
  baseSelectedModels: SelectedModels;
  selectedModels: SelectedModels;
  selectionSources: ModelSelectionSources;
}) {
  const nextModels: SelectedModels = { ...input.selectedModels };
  const nextSources: ModelSelectionSources = { ...input.selectionSources };
  let modelsChanged = false;
  let sourcesChanged = false;

  for (const type of ["llm", "image", "vision"] as const) {
    if (input.selectionSources[type] === "user") {
      continue;
    }

    const alias = resolveSkillModelAliasForType({
      activeSkillIds: input.activeSkillIds,
      availableSkills: input.availableSkills,
      type,
    });

    if (alias) {
      const model = findModelItemByAlias({
        alias,
        availableModels: input.availableModels,
        type,
      });
      if (!model) {
        continue;
      }
      if (!sameModel(input.selectedModels[type], model)) {
        nextModels[type] = model;
        modelsChanged = true;
      }
      if (input.selectionSources[type] !== "skill") {
        nextSources[type] = "skill";
        sourcesChanged = true;
      }
      continue;
    }

    if (input.selectionSources[type] === "skill") {
      const model =
        input.baseSelectedModels[type] ?? input.availableModels[type][0] ?? null;
      if (!sameModel(input.selectedModels[type], model)) {
        nextModels[type] = model;
        modelsChanged = true;
      }
      nextSources[type] = "system";
      sourcesChanged = true;
    }
  }

  return {
    modelsChanged,
    nextModels,
    nextSources,
    sourcesChanged,
  };
}
