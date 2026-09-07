import type {
  AgentToolTurnPreflight,
  AgentToolTurnPreflightInput,
  AgentToolLlmExecutionConfig,
} from "@sourceweft/contracts/agent-tools";

export type ReviewDeckVisualsVisionProfile = {
  readonly gatewayConfigId: string;
  readonly profileAlias: string;
  readonly modelAlias: string;
};

export type ReviewDeckVisualsTurnState = {
  readonly visionProfile: ReviewDeckVisualsVisionProfile | null;
  readonly execution?: AgentToolLlmExecutionConfig;
};

/**
 * Settle the selected vision profile before the turn runs. A workspace with no
 * vision profile still binds the tool: it answers `skipped` instead, so the
 * degradation is visible in the QA record rather than a silently missing tool.
 */
export const reviewDeckVisualsTurnPreflight: AgentToolTurnPreflight = {
  async run(input: AgentToolTurnPreflightInput) {
    const execution =
      input.execution && typeof input.execution === "object"
        ? (input.execution as AgentToolLlmExecutionConfig)
        : undefined;
    const byok = execution?.executionMode === "BYOK";
    let profile;
    if (byok) {
      const modelAlias = execution.providerModel ?? execution.modelAlias;
      const providerKind =
        execution.byok?.providerKind ?? execution.providerHint;
      if (
        !modelAlias ||
        !providerKind ||
        !execution.byokModelId ||
        !execution.credentialId ||
        !execution.byok
      ) {
        throw new Error(
          "PPT_VISION_BYOK_EXECUTION_INVALID: resolved model, credential and provider routing are required",
        );
      }
      profile = input.services.synthesizeByokProfile({
        profileAlias: `byok:vision:${execution.byokModelId}:${execution.credentialId}`,
        modelAlias,
        providerKind,
      });
    } else {
      const explicitDefault = input.requestedProfileAlias === null;
      const skillProfile = input.enabledSkills
        .filter((skill) => skill.tools?.includes(input.toolName))
        .map((skill) => skill.models?.vision)
        .find(Boolean);
      const explicitProfile =
        input.requestedProfileAlias ?? execution?.profileAlias;
      const explicitModel = execution?.modelAlias ?? execution?.providerModel;
      const profileAlias = explicitDefault
        ? undefined
        : (explicitProfile ??
          (explicitModel
            ? undefined
            : (input.threadProfileAlias ?? skillProfile ?? undefined)));
      const modelAlias =
        explicitDefault || profileAlias ? undefined : explicitModel;
      profile = await input.services.resolveProfile({
        ...(profileAlias ? { profileAlias } : modelAlias ? { modelAlias } : {}),
        required: Boolean(profileAlias || modelAlias),
      });
    }
    const state: ReviewDeckVisualsTurnState = {
      visionProfile: profile
        ? {
            gatewayConfigId: profile.gatewayConfigId,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
          }
        : null,
      execution: byok
        ? execution
        : profile
          ? {
              ...execution,
              profileAlias: profile.profileAlias,
              modelAlias: profile.modelAlias,
            }
          : undefined,
    };
    return { state };
  },
};

export function readReviewDeckVisualsTurnState(
  turnState: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
): ReviewDeckVisualsTurnState | undefined {
  return turnState?.[toolName] as ReviewDeckVisualsTurnState | undefined;
}
