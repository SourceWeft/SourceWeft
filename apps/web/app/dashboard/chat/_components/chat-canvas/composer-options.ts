export type ComposerOptionValue = string | number | boolean;

export type ComposerOptionOverrides = Record<
  string,
  Record<string, ComposerOptionValue | undefined>
>;

export type ComposerToolEnabledOverrides = Record<string, boolean | undefined>;

export type ComposerOptionsState = {
  capabilityOptionOverrides: ComposerOptionOverrides;
  capabilityToolEnabledOverrides: ComposerToolEnabledOverrides;
  skillOptionOverrides: ComposerOptionOverrides;
};

export const EMPTY_COMPOSER_OPTIONS: ComposerOptionsState = {
  capabilityOptionOverrides: {},
  capabilityToolEnabledOverrides: {},
  skillOptionOverrides: {},
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionValue(value: unknown): value is ComposerOptionValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function normalizeOptionOverrides(value: unknown): ComposerOptionOverrides {
  if (!isPlainRecord(value)) {
    return {};
  }

  const next: ComposerOptionOverrides = {};
  for (const [scopeId, scopeValue] of Object.entries(value)) {
    if (!isPlainRecord(scopeValue)) {
      continue;
    }
    const scoped: Record<string, ComposerOptionValue> = {};
    for (const [optionId, optionValue] of Object.entries(scopeValue)) {
      if (isOptionValue(optionValue)) {
        scoped[optionId] = optionValue;
      }
    }
    if (Object.keys(scoped).length > 0) {
      next[scopeId] = scoped;
    }
  }
  return next;
}

function normalizeToolEnabledOverrides(
  value: unknown,
): ComposerToolEnabledOverrides {
  if (!isPlainRecord(value)) {
    return {};
  }

  const next: ComposerToolEnabledOverrides = {};
  for (const [toolName, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      next[toolName] = enabled;
    }
  }
  return next;
}

export function normalizeComposerOptionsState(
  value: unknown,
): ComposerOptionsState {
  if (!isPlainRecord(value)) {
    return EMPTY_COMPOSER_OPTIONS;
  }
  return {
    capabilityOptionOverrides: normalizeOptionOverrides(
      value.capabilityOptionOverrides,
    ),
    capabilityToolEnabledOverrides: normalizeToolEnabledOverrides(
      value.capabilityToolEnabledOverrides,
    ),
    skillOptionOverrides: normalizeOptionOverrides(value.skillOptionOverrides),
  };
}

export function isComposerOptionsStateEmpty(value: ComposerOptionsState) {
  return (
    Object.keys(value.capabilityOptionOverrides).length === 0 &&
    Object.keys(value.capabilityToolEnabledOverrides).length === 0 &&
    Object.keys(value.skillOptionOverrides).length === 0
  );
}

export function composerOptionsStatesEqual(
  left: ComposerOptionsState,
  right: ComposerOptionsState,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}
