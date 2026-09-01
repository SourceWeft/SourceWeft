import type {
  AgentToolLlmExecutionConfig,
  AgentToolModelProfileView,
  AgentToolTurnPreflight,
} from "@sourceweft/contracts/agent-tools";

export type VideoModelTurnState = {
  profile: AgentToolModelProfileView | null;
  execution?: AgentToolLlmExecutionConfig;
};

function executionConfig(
  value: unknown,
): AgentToolLlmExecutionConfig | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AgentToolLlmExecutionConfig)
    : undefined;
}

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function createVideoModelTurnPreflight(input: {
  required: boolean;
}): AgentToolTurnPreflight {
  return {
    run: async (preflightInput) => {
      const execution = executionConfig(preflightInput.execution);
      const skillProfileAlias = preflightInput.enabledSkills
        .filter((skill) => skill.tools?.includes(preflightInput.toolName))
        .map((skill) =>
          preflightInput.modelKind
            ? skill.models?.[preflightInput.modelKind]
            : null,
        )
        .find((value): value is string => Boolean(value));
      let profile: AgentToolModelProfileView | null;
      if (execution?.executionMode === "BYOK") {
        const byokModelAlias =
          nonEmpty(execution.providerModel) ??
          nonEmpty(execution.modelAlias) ??
          nonEmpty(execution.byokModelId);
        const providerKind =
          nonEmpty(execution.byok?.providerKind) ??
          nonEmpty(execution.providerHint);
        if (
          !byokModelAlias ||
          !execution.byokModelId ||
          !execution.credentialId ||
          !execution.byok ||
          !providerKind
        ) {
          throw new Error(
            "VIDEO_BYOK_EXECUTION_INVALID: resolved model, credential, and provider routing are required",
          );
        }
        profile = preflightInput.services.synthesizeByokProfile({
          profileAlias: `byok:${preflightInput.modelKind ?? "model"}:${execution.byokModelId}:${execution.credentialId}`,
          modelAlias: byokModelAlias,
          providerKind,
        });
      } else {
        const explicitDefault = preflightInput.requestedProfileAlias === null;
        const requestedProfileAlias = explicitDefault
          ? undefined
          : nonEmpty(
              preflightInput.requestedProfileAlias ?? execution?.profileAlias,
            );
        const requestedModelAlias =
          nonEmpty(execution?.modelAlias) ?? nonEmpty(execution?.providerModel);
        const inheritedProfileAlias =
          nonEmpty(preflightInput.threadProfileAlias) ?? skillProfileAlias;
        profile = await preflightInput.services.resolveProfile({
          ...(requestedProfileAlias
            ? { profileAlias: requestedProfileAlias }
            : requestedModelAlias && !explicitDefault
              ? { modelAlias: requestedModelAlias }
              : !explicitDefault && inheritedProfileAlias
                ? { profileAlias: inheritedProfileAlias }
                : {}),
          required: input.required,
        });
      }
      return {
        state: {
          profile,
          execution,
        } satisfies VideoModelTurnState,
      };
    },
  };
}

export function readVideoModelTurnState(
  state: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
) {
  return state?.[toolName] as VideoModelTurnState | undefined;
}
